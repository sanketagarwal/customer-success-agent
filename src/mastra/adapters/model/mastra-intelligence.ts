import type { Agent } from '@mastra/core/agent';

import type { CustomerSuccessIntelligence, PlanningInput } from '../../ports/index.js';
import {
  accountPlanSchema,
  healthAssessmentSchema,
  outreachDraftSchema,
  sourceSnapshotSchema,
  type AccountPlan,
  type GenerationUsage,
  type HealthAssessment,
  type SourceSnapshot,
} from '../../schemas/index.js';
import { scopeKey } from '../../invariants/index.js';

const generatedAssessmentSchema = healthAssessmentSchema.omit({ sourceSnapshotHash: true });

const evidencePolicy = [
  'Evidence policy:',
  'cite only primitive values exactly as they appear in the normalized source records;',
  'never cite support subject, CRM body, CRM authorId, or any field whose value is [REDACTED] or null;',
  'use structured CRM sentiment rather than CRM body text;',
  'unknown, empty, and redacted values describe missing information and must never be treated as risk evidence;',
  'omit a risk, action, or claim when no permitted evidence supports it.',
].join(' ');

function modelSafeSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  const safe = structuredClone(snapshot);
  if (safe.support.status === 'available') {
    safe.support.data.tickets = safe.support.data.tickets.map((ticket) => ({
      ...ticket,
      subject: '[REDACTED]',
    }));
  }
  if (safe.crm.status === 'available') {
    safe.crm.data.notes = safe.crm.data.notes.map((note) => ({
      ...note,
      authorId: null,
      body: '[REDACTED]',
    }));
  }
  return sourceSnapshotSchema.parse(safe);
}

export function assessmentPrompt(snapshot: SourceSnapshot): string {
  return `Create a structured health assessment from this normalized, redacted source snapshot.\n${evidencePolicy}\n${JSON.stringify(modelSafeSnapshot(snapshot))}`;
}

function planPrompt(assessment: HealthAssessment, snapshot: SourceSnapshot): string {
  return `Create an evidence-backed account plan.\n${evidencePolicy}\nAssessment:\n${JSON.stringify(assessment)}\nRedacted sources:\n${JSON.stringify(modelSafeSnapshot(snapshot))}`;
}

function outreachPrompt(
  assessment: HealthAssessment,
  plan: AccountPlan,
  snapshot: SourceSnapshot,
): string {
  return `Draft concise outreach for CSM review. It must remain draft-only.\n${evidencePolicy}\nAssessment:\n${JSON.stringify(assessment)}\nPlan:\n${JSON.stringify(plan)}\nRedacted sources:\n${JSON.stringify(modelSafeSnapshot(snapshot))}`;
}

export class MastraCustomerSuccessIntelligence implements CustomerSuccessIntelligence {
  private readonly usage = new Map<string, GenerationUsage>();

  constructor(
    private readonly agent: Agent,
    private readonly pricing: { inputCostPerMillion: number; outputCostPerMillion: number } = {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
  ) {}

  private key(tenantId: string, accountId: string): string {
    return `${tenantId}\u0000${accountId}`;
  }

  private async captureUsage(
    response: Awaited<ReturnType<Agent['generate']>>,
    tenantId: string,
    accountId: string,
  ): Promise<void> {
    const usage = await response.totalUsage;
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
    const costUsd =
      (inputTokens * this.pricing.inputCostPerMillion +
        outputTokens * this.pricing.outputCostPerMillion) /
      1_000_000;
    const key = this.key(tenantId, accountId);
    const previous = this.usage.get(key) ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    this.usage.set(key, {
      inputTokens: previous.inputTokens + inputTokens,
      outputTokens: previous.outputTokens + outputTokens,
      totalTokens: previous.totalTokens + totalTokens,
      costUsd: previous.costUsd + costUsd,
    });
  }

  takeUsage(tenantId: string, accountId: string): GenerationUsage {
    const key = this.key(tenantId, accountId);
    const usage = this.usage.get(key) ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    this.usage.delete(key);
    return usage;
  }

  async assess(input: Parameters<CustomerSuccessIntelligence['assess']>[0]) {
    const response = await this.agent.generate(
      assessmentPrompt(input.snapshot),
      {
        memory: {
          resource: scopeKey(input.snapshot.tenantId, input.snapshot.accountId),
          thread: `assessment:${input.snapshot.accountId}:${input.asOf}`,
        },
        structuredOutput: { schema: generatedAssessmentSchema, jsonPromptInjection: 'auto' },
      },
    );
    const [object] = await Promise.all([
      response.object,
      this.captureUsage(response, input.snapshot.tenantId, input.snapshot.accountId),
    ]);
    return generatedAssessmentSchema.parse(object);
  }

  async plan(input: PlanningInput) {
    const response = await this.agent.generate(
      planPrompt(input.assessment, input.snapshot),
      {
        memory: {
          resource: scopeKey(input.assessment.tenantId, input.assessment.accountId),
          thread: `plan:${input.assessment.accountId}:${input.asOf}`,
        },
        structuredOutput: { schema: accountPlanSchema, jsonPromptInjection: 'auto' },
      },
    );
    const [object] = await Promise.all([
      response.object,
      this.captureUsage(response, input.assessment.tenantId, input.assessment.accountId),
    ]);
    return accountPlanSchema.parse(object);
  }

  async draftOutreach(input: PlanningInput & { plan: Awaited<ReturnType<CustomerSuccessIntelligence['plan']>> }) {
    const response = await this.agent.generate(
      outreachPrompt(input.assessment, input.plan, input.snapshot),
      {
        memory: {
          resource: scopeKey(input.assessment.tenantId, input.assessment.accountId),
          thread: `outreach:${input.assessment.accountId}:${input.asOf}`,
        },
        structuredOutput: { schema: outreachDraftSchema, jsonPromptInjection: 'auto' },
      },
    );
    const [object] = await Promise.all([
      response.object,
      this.captureUsage(response, input.assessment.tenantId, input.assessment.accountId),
    ]);
    return outreachDraftSchema.parse(object);
  }
}
