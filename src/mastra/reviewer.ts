import type { Agent } from '@mastra/core/agent';
import { Agent as MastraAgent } from '@mastra/core/agent';
import type { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

import {
  generatedReviewSchema,
  snapshotSchema,
  type Evidence,
  type GeneratedReview,
  type Snapshot,
} from './schemas.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Reviewer {
  review(snapshot: Snapshot): Promise<{ review: GeneratedReview; usage: Usage }>;
}

export function createCustomerSuccessAgent(options: {
  model: string;
  storage: LibSQLStore;
  vector?: LibSQLVector;
  embedder?: NonNullable<ConstructorParameters<typeof Memory>[0]>['embedder'];
  observationalMemory: boolean;
}) {
  return new MastraAgent({
    id: 'customer-success-agent',
    name: 'Customer Success Agent',
    model: options.model,
    maxRetries: 2,
    instructions: [
      'Review the supplied account data for renewal and churn risk.',
      'Return one concise health assessment, account plan, and outreach draft.',
      'Support every customer-specific claim with an exact source, recordId, field, and primitive value.',
      'Never cite support subjects, CRM note bodies, author IDs, nulls, unknown values, or redacted text.',
      'Never invent metrics, commitments, conversations, or customer intent.',
      'Outreach is always a draft that requires CSM approval.',
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

export const redactSnapshot = (snapshot: Snapshot) => {
  const safe = structuredClone(snapshot);
  if (safe.support.status === 'available') {
    safe.support.data.tickets = safe.support.data.tickets.map(ticket => ({ ...ticket, subject: '[REDACTED]' }));
  }
  if (safe.crm.status === 'available') {
    safe.crm.data.notes = safe.crm.data.notes.map(note => ({ ...note, authorId: null, body: '[REDACTED]' }));
  }
  return snapshotSchema.parse(safe);
};

export class ModelReviewer implements Reviewer {
  constructor(
    private readonly agent: Agent,
    private readonly inputCostPerMillion = 0,
    private readonly outputCostPerMillion = 0,
  ) {}

  async review(snapshot: Snapshot) {
    const response = await this.agent.generate(
      `Prepare the complete customer-success review from this normalized account snapshot:\n${JSON.stringify(redactSnapshot(snapshot))}`,
      {
        memory: {
          resource: `${snapshot.tenantId}:${snapshot.accountId}`,
          thread: `review:${snapshot.accountId}:${snapshot.window.end}`,
        },
        structuredOutput: { schema: generatedReviewSchema, jsonPromptInjection: 'auto' },
      },
    );
    const [result, usage] = await Promise.all([response.object, response.totalUsage]);
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    return {
      review: generatedReviewSchema.parse(result),
      usage: {
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * this.inputCostPerMillion + outputTokens * this.outputCostPerMillion) / 1_000_000,
      },
    };
  }
}

const evidence = (source: Evidence['source'], recordId: string, field: string, value: Evidence['value']): Evidence => ({
  source,
  recordId,
  field,
  value,
});

export class FixtureReviewer implements Reviewer {
  async review(snapshot: Snapshot) {
    const risks: GeneratedReview['assessment']['riskFactors'] = [];
    if (snapshot.usage.status === 'available' && snapshot.usage.data.points.length > 1) {
      const points = [...snapshot.usage.data.points].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const first = points[0]!;
      const last = points.at(-1)!;
      if (first.adoptionRate - last.adoptionRate >= 0.15) {
        risks.push({
          id: 'declining-adoption',
          category: 'adoption',
          severity: first.adoptionRate - last.adoptionRate >= 0.3 ? 'critical' : 'high',
          evidence: [
            evidence('usage', first.recordId, 'adoptionRate', first.adoptionRate),
            evidence('usage', last.recordId, 'adoptionRate', last.adoptionRate),
          ],
        });
      }
    }
    if (snapshot.support.status === 'available') {
      const ticket = snapshot.support.data.tickets.find(
        item => item.priority === 'urgent' && !['closed', 'resolved'].includes(item.status),
      );
      if (ticket) risks.push({
        id: 'urgent-support-issue',
        category: 'support',
        severity: 'high',
        evidence: [evidence('support', ticket.recordId, 'status', ticket.status)],
      });
    }
    if (snapshot.billing.status === 'available' && snapshot.billing.data.standing !== 'current') {
      const billing = snapshot.billing.data;
      risks.push({
        id: 'billing-risk',
        category: 'billing',
        severity: billing.standing === 'delinquent' ? 'critical' : 'high',
        evidence: [
          evidence('billing', billing.recordId, 'standing', billing.standing),
          evidence('billing', billing.recordId, 'daysPastDue', billing.daysPastDue),
        ],
      });
    }
    if (snapshot.crm.status === 'available') {
      const note = snapshot.crm.data.notes.find(item => item.sentiment === 'negative');
      if (note) risks.push({
        id: 'negative-relationship-signal',
        category: 'relationship',
        severity: 'medium',
        evidence: [evidence('crm', note.recordId, 'sentiment', note.sentiment)],
      });
    }
    const penalty = { low: 8, medium: 16, high: 28, critical: 42 } as const;
    const score = Math.max(0, 100 - risks.reduce((total, risk) => total + penalty[risk.severity], 0));
    const status = score >= 80 ? 'healthy' : score >= 60 ? 'watch' : score >= 35 ? 'at_risk' : 'critical';
    const dueAt = new Date(Date.parse(snapshot.window.end) + 7 * 86_400_000).toISOString();
    const actions = risks.map((risk, index) => ({
      id: `action-${index + 1}-${risk.id}`,
      owner: risk.category === 'billing' ? 'billing' as const : risk.category === 'support' ? 'support' as const : 'csm' as const,
      dueAt,
      priority: risk.severity === 'low' || risk.severity === 'medium' ? 'medium' as const : 'high' as const,
      evidence: risk.evidence,
    }));
    const review = generatedReviewSchema.parse({
      assessment: {
        score,
        status,
        riskFactors: risks,
        dataCompleteness: [snapshot.usage, snapshot.support, snapshot.billing, snapshot.crm]
          .filter(result => result.status === 'available').length / 4,
      },
      plan: { actions },
      outreach: {
        channel: 'email',
        claims: risks.map(risk => ({ evidence: risk.evidence })),
        draftOnly: true,
      },
    });
    return { review, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}
