import type { Agent } from '@mastra/core/agent';

import type { CustomerSuccessIntelligence, PlanningInput } from '../../ports/index.js';
import {
  accountPlanSchema,
  healthAssessmentSchema,
  outreachDraftSchema,
  sourceSnapshotSchema,
  type AccountPlan,
  type HealthAssessment,
  type SourceSnapshot,
} from '../../schemas/index.js';
import { scopeKey } from '../../invariants/index.js';

const generatedAssessmentSchema = healthAssessmentSchema.omit({ sourceSnapshotHash: true });

export function modelSafeSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
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
  return `Create a structured health assessment from this normalized, redacted source snapshot.\n${JSON.stringify(modelSafeSnapshot(snapshot))}`;
}

function planPrompt(assessment: HealthAssessment, snapshot: SourceSnapshot): string {
  return `Create an evidence-backed account plan.\nAssessment:\n${JSON.stringify(assessment)}\nRedacted sources:\n${JSON.stringify(modelSafeSnapshot(snapshot))}`;
}

function outreachPrompt(
  assessment: HealthAssessment,
  plan: AccountPlan,
  snapshot: SourceSnapshot,
): string {
  return `Draft concise outreach for CSM review. It must remain draft-only.\nAssessment:\n${JSON.stringify(assessment)}\nPlan:\n${JSON.stringify(plan)}\nRedacted sources:\n${JSON.stringify(modelSafeSnapshot(snapshot))}`;
}

export class MastraCustomerSuccessIntelligence implements CustomerSuccessIntelligence {
  constructor(private readonly agent: Agent) {}

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
    return generatedAssessmentSchema.parse(response.object);
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
    return accountPlanSchema.parse(response.object);
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
    return outreachDraftSchema.parse(response.object);
  }
}
