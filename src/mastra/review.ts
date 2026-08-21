import { createHash } from 'node:crypto';

import { Agent } from '@mastra/core/agent';
import type { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

import {
  proposalSchema,
  reviewSchema,
  snapshotSchema,
  type Evidence,
  type Proposal,
  type Review,
  type Snapshot,
} from './schemas.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Reviewer {
  review(snapshot: Snapshot): Promise<{ proposal: Proposal; usage: Usage }>;
}

export function createAgent(options: {
  model: string;
  storage: LibSQLStore;
  vector?: LibSQLVector;
  embedder?: NonNullable<ConstructorParameters<typeof Memory>[0]>['embedder'];
  observationalMemory: boolean;
}) {
  return new Agent({
    id: 'customer-success-agent',
    name: 'Customer Success Agent',
    model: options.model,
    maxRetries: 2,
    instructions: [
      'Find renewal and churn risks in the supplied account snapshot.',
      'Return a concise health score, evidence-backed risks, actions, and outreach claims.',
      'Every claim must cite an exact source, recordId, field, and primitive value.',
      'Never cite support subjects, CRM note bodies, unknown values, or redacted text.',
      'Never invent metrics, conversations, commitments, or customer intent.',
    ].join(' '),
    memory: new Memory({
      storage: options.storage,
      ...(options.vector ? { vector: options.vector } : {}),
      ...(options.embedder ? { embedder: options.embedder } : {}),
      options: {
        lastMessages: 10,
        semanticRecall: options.vector ? { topK: 3, messageRange: 1, scope: 'resource' } : false,
        workingMemory: {
          enabled: true,
          scope: 'resource',
          template: '# Account context\n- Verified risks:\n- Approved actions:\n- Open CSM questions:',
        },
        observationalMemory: options.observationalMemory
          ? { model: options.model, observation: { bufferOnIdle: true } }
          : false,
      },
    }),
  });
}

export function redact(snapshot: Snapshot) {
  const safe = structuredClone(snapshot);
  if (safe.support.status === 'available') {
    safe.support.data = safe.support.data.map(ticket => ({ ...ticket, subject: '[REDACTED]' }));
  }
  if (safe.crm.status === 'available') {
    safe.crm.data = safe.crm.data.map(note => ({ ...note, body: '[REDACTED]' }));
  }
  return snapshotSchema.parse(safe);
}

export class ModelReviewer implements Reviewer {
  constructor(
    private readonly agent: Agent,
    private readonly inputCost = 0,
    private readonly outputCost = 0,
  ) {}

  async review(snapshot: Snapshot) {
    const safe = redact(snapshot);
    const response = await this.agent.generate(`Review this account snapshot:\n${JSON.stringify(safe)}`, {
      memory: {
        resource: `${snapshot.tenantId}:${snapshot.accountId}`,
        thread: `review:${snapshot.accountId}:${snapshot.window.end}`,
      },
      structuredOutput: { schema: proposalSchema, jsonPromptInjection: 'auto' },
    });
    const [proposal, usage] = await Promise.all([response.object, response.totalUsage]);
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    return {
      proposal: proposalSchema.parse(proposal),
      usage: {
        inputTokens,
        outputTokens,
        costUsd: (inputTokens * this.inputCost + outputTokens * this.outputCost) / 1_000_000,
      },
    };
  }
}

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
};
export const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
export const snapshotHash = ({ window: _window, ...snapshot }: Snapshot) => hash(snapshot);

const allowed: Record<Evidence['source'], ReadonlySet<string>> = {
  usage: new Set(['activeUsers', 'adoptionRate']),
  support: new Set(['createdAt', 'status', 'priority']),
  billing: new Set(['asOf', 'standing', 'renewalAt', 'daysPastDue']),
  crm: new Set(['createdAt', 'sentiment']),
};

function records(snapshot: Snapshot, source: Evidence['source']): readonly Record<string, unknown>[] {
  const value = snapshot[source];
  if (value.status !== 'available') return [];
  return Array.isArray(value.data) ? value.data : [value.data];
}

function isGrounded(item: Evidence, snapshot: Snapshot) {
  const record = records(snapshot, item.source).find(value => value.recordId === item.recordId);
  return allowed[item.source].has(item.field) && record !== undefined && Object.is(record[item.field], item.value);
}

const format = ({ field, value }: Evidence) =>
  field === 'adoptionRate' && typeof value === 'number'
    ? `${Math.round(value * 100)}%`
    : field.endsWith('At') && typeof value === 'string'
      ? value.slice(0, 10)
      : String(value).replaceAll('_', ' ');

const labels: Record<string, string> = {
  activeUsers: 'active users',
  adoptionRate: 'product adoption',
  createdAt: 'record date',
  status: 'support status',
  priority: 'support priority',
  asOf: 'billing date',
  standing: 'billing standing',
  renewalAt: 'renewal date',
  daysPastDue: 'days past due',
  sentiment: 'relationship sentiment',
};

function sentence(evidence: readonly Evidence[]) {
  if (evidence.length === 2 && evidence.every(item => item.field === 'adoptionRate')) {
    return `Product adoption moved from ${format(evidence[0]!)} to ${format(evidence[1]!)}.`;
  }
  const text = evidence.map(item => `${labels[item.field] ?? item.field} is ${format(item)}`).join('; ');
  return `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}.`;
}

const actionTitle = (evidence: readonly Evidence[]) => {
  if (evidence.some(item => item.source === 'usage')) return 'Review product adoption and recovery steps';
  if (evidence.some(item => item.source === 'support')) return 'Resolve the urgent support issue';
  if (evidence.some(item => item.source === 'billing')) return 'Resolve the billing risk';
  return 'Review the relationship signal with the account team';
};

export function buildReview(proposal: Proposal, snapshot: Snapshot, previous: Review | null) {
  const previousScore = previous?.assessment.score ?? null;
  const scoreDelta = previousScore === null ? 0 : proposal.score - previousScore;
  const claimText = proposal.claims.map(claim => sentence(claim.evidence));
  return reviewSchema.parse({
    asOf: snapshot.window.end,
    sourceHash: snapshotHash(snapshot),
    assessment: {
      score: proposal.score,
      status: proposal.status,
      completeness: [snapshot.usage, snapshot.support, snapshot.billing, snapshot.crm]
        .filter(result => result.status === 'available').length / 4,
      summary: proposal.risks.length
        ? `${proposal.risks.length} verified risk factor(s); health is ${proposal.status} at ${proposal.score}/100.`
        : `No verified churn risks; health is ${proposal.status} at ${proposal.score}/100.`,
      risks: proposal.risks.map(risk => ({
        ...risk,
        title: `Verified ${risk.category} risk (${risk.severity})`,
        explanation: sentence(risk.evidence),
      })),
    },
    drift: {
      previousScore,
      scoreDelta,
      direction: previousScore === null ? 'baseline' : scoreDelta >= 5 ? 'improving' : scoreDelta <= -5 ? 'worsening' : 'stable',
    },
    plan: {
      actions: proposal.actions.map(action => ({
        ...action,
        title: actionTitle(action.evidence),
        rationale: sentence(action.evidence),
      })),
    },
    outreach: {
      subject: 'Account review and next steps',
      body: claimText.length
        ? `Hi — I’d like to check in about a few account signals. ${claimText.join(' ')} Could we align on next steps?`
        : 'Hi — I would like to check in and make sure your current priorities are on track.',
      claims: proposal.claims,
    },
  });
}

export function groundingIssues(review: Review, snapshot: Snapshot) {
  const risks = review.assessment.risks;
  const riskEvidence = new Set(risks.flatMap(risk => risk.evidence.map(hash)));
  const groups = [
    ...risks.map((risk, index) => [`risks[${index}]`, risk.evidence] as const),
    ...review.plan.actions.map((action, index) => [`actions[${index}]`, action.evidence] as const),
    ...review.outreach.claims.map((claim, index) => [`claims[${index}]`, claim.evidence] as const),
  ];
  const issues = groups.flatMap(([name, evidence]) => evidence.flatMap((item, index) =>
    isGrounded(item, snapshot) ? [] : [`${name}.evidence[${index}]`],
  ));
  for (const [name, items] of groups.slice(risks.length)) {
    if (!items.some(item => riskEvidence.has(hash(item)))) issues.push(`${name}.relevance`);
  }
  for (const [index, risk] of risks.entries()) {
    const refs = new Set(risk.evidence.map(hash));
    if (!review.plan.actions.some(action => action.evidence.some(item => refs.has(hash(item))))) issues.push(`risks[${index}].planCoverage`);
    if (!review.outreach.claims.some(claim => claim.evidence.some(item => refs.has(hash(item))))) issues.push(`risks[${index}].outreachCoverage`);
  }
  return issues;
}

export async function prepareReview(snapshot: Snapshot, reviewer: Reviewer, previous: Review | null) {
  const { proposal, usage } = await reviewer.review(snapshot);
  const review = buildReview(proposal, snapshot, previous);
  return { review, usage, issues: groundingIssues(review, snapshot) };
}
