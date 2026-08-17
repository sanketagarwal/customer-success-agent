import type { Agent } from '@mastra/core/agent';

import type { CustomerSuccessIntelligence, PlanningInput } from '../../ports/index.js';
import {
  accountPlanSchema,
  healthAssessmentSchema,
  outreachDraftSchema,
} from '../../schemas/index.js';
import { scopeKey } from '../../invariants/index.js';

const generatedAssessmentSchema = healthAssessmentSchema.omit({ sourceSnapshotHash: true });

export class MastraCustomerSuccessIntelligence implements CustomerSuccessIntelligence {
  constructor(private readonly agent: Agent) {}

  async assess(input: Parameters<CustomerSuccessIntelligence['assess']>[0]) {
    const response = await this.agent.generate(
      `Create a structured health assessment from this normalized source snapshot.\n${JSON.stringify(input.snapshot)}`,
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
      `Create an evidence-backed account plan.\nAssessment:\n${JSON.stringify(input.assessment)}\nSources:\n${JSON.stringify(input.snapshot)}`,
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
      `Draft concise, personalized outreach for CSM review. It must remain draft-only.\nAssessment:\n${JSON.stringify(input.assessment)}\nPlan:\n${JSON.stringify(input.plan)}\nSources:\n${JSON.stringify(input.snapshot)}`,
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
