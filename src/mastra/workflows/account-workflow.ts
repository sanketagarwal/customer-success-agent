import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { Composition } from '../composition/create-composition.js';
import { ProviderUnavailableError } from '../errors/provider-unavailable-error.js';
import type { ApprovalStore } from '../ports/index.js';
import {
  accountMemorySchema,
  accountPlanSchema,
  approvalDecisionSchema,
  approvalRequestSchema,
  billingStatusSchema,
  crmNotesSchema,
  crmTaskWriteResultSchema,
  crmWriteInputSchema,
  crmWriteResultSchema,
  driftSchema,
  healthAssessmentSchema,
  outreachDraftSchema,
  preparedRunSchema,
  sourceReadResultSchema,
  sourceSnapshotSchema,
  supportHistorySchema,
  timeWindowSchema,
  usageSeriesSchema,
} from '../schemas/index.js';
import { assessmentWindow } from '../services/customer-success-service.js';

export const accountRunInputSchema = z.object({
  accountId: z
    .string()
    .min(1)
    .default('340734348989')
    .describe('CRM account ID. Studio prefills the built-in at-risk demo account.'),
});

export const approvalResumeSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  approverId: z.string().min(1),
  feedback: z.string().max(4000).optional(),
});

const reviewInitializationSchema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  asOf: z.iso.datetime({ offset: true }),
  window: timeWindowSchema,
  startedAtMs: z.number().int().nonnegative(),
});

const usageReadSchema = reviewInitializationSchema.extend({
  usage: sourceReadResultSchema(usageSeriesSchema),
});
const supportReadSchema = reviewInitializationSchema.extend({
  support: sourceReadResultSchema(supportHistorySchema),
});
const billingReadSchema = reviewInitializationSchema.extend({
  billing: sourceReadResultSchema(billingStatusSchema),
});
const crmReadSchema = reviewInitializationSchema.extend({
  crm: sourceReadResultSchema(crmNotesSchema),
});

const parallelReadsSchema = z.object({
  'read-product-usage': usageReadSchema,
  'read-support-history': supportReadSchema,
  'read-billing-status': billingReadSchema,
  'read-crm-notes': crmReadSchema,
});

const reviewPipelineSchema = z.object({
  initialization: reviewInitializationSchema,
  snapshot: sourceSnapshotSchema,
  previous: accountMemorySchema.nullable(),
  assessment: healthAssessmentSchema.nullable(),
  drift: driftSchema.nullable(),
  plan: accountPlanSchema.nullable(),
  outreach: outreachDraftSchema.nullable(),
  terminal: preparedRunSchema.nullable(),
});

const approvalStepOutputSchema = z.object({
  prepared: preparedRunSchema,
  decision: approvalDecisionSchema.nullable(),
  startedAtMs: z.number().int().nonnegative(),
});

const approvalValidationSchema = z.object({
  prepared: preparedRunSchema,
  decision: approvalDecisionSchema.nullable(),
  run: preparedRunSchema,
  writeInput: crmWriteInputSchema.nullable(),
  startedAtMs: z.number().int().nonnegative(),
});

const taskWriteStageSchema = approvalValidationSchema.extend({
  tasks: crmTaskWriteResultSchema.nullable(),
});

const noteWriteStageSchema = taskWriteStageSchema.extend({
  note: crmWriteResultSchema.nullable(),
});

export const accountRunOutputSchema = preparedRunSchema.extend({
  writeId: z.string().nullable(),
  created: z.boolean().nullable(),
  taskIds: z.array(z.string()),
  tasksCreated: z.number().int().nonnegative().nullable(),
  tasksReused: z.number().int().nonnegative().nullable(),
});

type AccountWorkflowDependencies = Pick<Composition, 'service'> & {
  config: Pick<Composition['config'], 'tenantId'>;
  operationalStore: Pick<ApprovalStore, 'getRequest'>;
};

function assertRequestIdentity(
  accountId: string,
  tenantId: string,
  requestContext: { get(key: string): unknown },
): void {
  const contextTenant = requestContext.get('tenant-id');
  const contextAccount = requestContext.get('account-id');
  if (contextTenant && contextTenant !== tenantId) {
    throw new Error('tenant RequestContext mismatch');
  }
  if (contextAccount && contextAccount !== accountId) {
    throw new Error('account RequestContext mismatch');
  }
}

function retryUnavailable(provider: string, result: { status: string }, retryCount: number): void {
  if (result.status === 'unavailable' && retryCount < 2) {
    throw new ProviderUnavailableError(
      provider,
      `Retryable ${provider} source failure on workflow attempt ${retryCount + 1}`,
    );
  }
}

export function createAccountWorkflow(composition: AccountWorkflowDependencies) {
  const initializeReview = createStep({
    id: 'initialize-account-review',
    description: 'Validate request identity and define the account review window.',
    inputSchema: accountRunInputSchema,
    outputSchema: reviewInitializationSchema,
    execute: async ({ inputData, requestContext, runId }) => {
      assertRequestIdentity(inputData.accountId, composition.config.tenantId, requestContext);
      const normalized = composition.service.normalizePrepareInput({
        runId,
        tenantId: composition.config.tenantId,
        accountId: inputData.accountId,
      });
      return {
        ...normalized,
        window: assessmentWindow(normalized.asOf),
        startedAtMs: Date.now(),
      };
    },
  });

  const readUsage = createStep({
    id: 'read-product-usage',
    description: 'Read normalized product-usage history for the assessment window.',
    inputSchema: reviewInitializationSchema,
    outputSchema: usageReadSchema,
    retries: 2,
    execute: async ({ inputData, retryCount }) => {
      const usage = await composition.service.readUsage(inputData.tenantId, inputData.accountId, inputData.window);
      retryUnavailable('usage', usage, retryCount);
      return { ...inputData, usage };
    },
  });

  const readSupport = createStep({
    id: 'read-support-history',
    description: 'Read normalized support history for the assessment window.',
    inputSchema: reviewInitializationSchema,
    outputSchema: supportReadSchema,
    retries: 2,
    execute: async ({ inputData, retryCount }) => {
      const support = await composition.service.readSupport(inputData.tenantId, inputData.accountId, inputData.window);
      retryUnavailable('support', support, retryCount);
      return { ...inputData, support };
    },
  });

  const readBilling = createStep({
    id: 'read-billing-status',
    description: 'Read normalized billing and renewal status for the account.',
    inputSchema: reviewInitializationSchema,
    outputSchema: billingReadSchema,
    retries: 2,
    execute: async ({ inputData, retryCount }) => {
      const billing = await composition.service.readBilling(inputData.tenantId, inputData.accountId, inputData.window);
      retryUnavailable('billing', billing, retryCount);
      return { ...inputData, billing };
    },
  });

  const readCrm = createStep({
    id: 'read-crm-notes',
    description: 'Read CRM notes from the configured adapter, including live HubSpot.',
    inputSchema: reviewInitializationSchema,
    outputSchema: crmReadSchema,
    retries: 2,
    execute: async ({ inputData, retryCount }) => {
      const crm = await composition.service.readCrm(inputData.tenantId, inputData.accountId, inputData.window);
      retryUnavailable('crm', crm, retryCount);
      return { ...inputData, crm };
    },
  });

  const assembleSnapshot = createStep({
    id: 'assemble-source-snapshot',
    description: 'Combine usage, support, billing, and CRM reads into one typed source snapshot.',
    inputSchema: parallelReadsSchema,
    outputSchema: reviewPipelineSchema,
    execute: async ({ inputData }) => {
      const initialization = inputData['read-product-usage'];
      const snapshot = sourceSnapshotSchema.parse({
        tenantId: initialization.tenantId,
        accountId: initialization.accountId,
        window: initialization.window,
        usage: initialization.usage,
        support: inputData['read-support-history'].support,
        billing: inputData['read-billing-status'].billing,
        crm: inputData['read-crm-notes'].crm,
      });
      return {
        initialization,
        snapshot,
        previous: null,
        assessment: null,
        drift: null,
        plan: null,
        outreach: null,
        terminal: null,
      };
    },
  });

  const assessHealth = createStep({
    id: 'assess-account-health',
    description: 'Create and ground the structured health assessment and risk factors.',
    inputSchema: reviewPipelineSchema,
    outputSchema: reviewPipelineSchema,
    retries: 2,
    execute: async ({ inputData }) => {
      if (inputData.terminal) return inputData;
      const assessed = await composition.service.assessHealth(inputData.initialization, inputData.snapshot);
      return {
        ...inputData,
        previous: assessed.previous,
        assessment: assessed.assessment,
        terminal: assessed.terminal,
      };
    },
  });

  const calculateDrift = createStep({
    id: 'calculate-risk-drift',
    description: 'Compare account memory, classify factor changes, and persist risk-score drift.',
    inputSchema: reviewPipelineSchema,
    outputSchema: reviewPipelineSchema,
    execute: async ({ inputData }) => {
      if (inputData.terminal || !inputData.assessment) return inputData;
      const risk = await composition.service.calculateRiskDrift(
        inputData.initialization,
        inputData.previous,
        inputData.assessment,
      );
      return {
        ...inputData,
        assessment: risk.assessment,
        drift: risk.drift,
        terminal: risk.terminal,
      };
    },
  });

  const createPlan = createStep({
    id: 'create-account-plan',
    description: 'Create a grounded owner, priority, and due-date account plan for verified risks.',
    inputSchema: reviewPipelineSchema,
    outputSchema: reviewPipelineSchema,
    retries: 2,
    execute: async ({ inputData }) => {
      if (inputData.terminal || !inputData.assessment || !inputData.drift) return inputData;
      const planned = await composition.service.createPlan(
        inputData.initialization,
        inputData.snapshot,
        inputData.assessment,
        inputData.drift,
      );
      return { ...inputData, plan: planned.plan, terminal: planned.terminal };
    },
  });

  const draftOutreach = createStep({
    id: 'draft-personalized-outreach',
    description: 'Draft evidence-backed customer outreach without sending it.',
    inputSchema: reviewPipelineSchema,
    outputSchema: reviewPipelineSchema,
    retries: 2,
    execute: async ({ inputData }) => {
      if (inputData.terminal || !inputData.assessment || !inputData.drift || !inputData.plan) return inputData;
      const drafted = await composition.service.draftOutreach(
        inputData.initialization,
        inputData.snapshot,
        inputData.assessment,
        inputData.drift,
        inputData.plan,
      );
      return { ...inputData, outreach: drafted.outreach, terminal: drafted.terminal };
    },
  });

  const bindArtifacts = createStep({
    id: 'bind-approval-artifacts',
    description: 'Persist the grounded artifacts and bind approval to their canonical hash.',
    inputSchema: reviewPipelineSchema,
    outputSchema: reviewPipelineSchema,
    execute: async ({ inputData }) => {
      if (inputData.terminal) return inputData;
      if (!inputData.assessment || !inputData.drift || !inputData.plan || !inputData.outreach) {
        throw new Error('Review artifacts were incomplete before approval binding');
      }
      const terminal = await composition.service.bindApprovalArtifacts(
        inputData.initialization,
        inputData.previous,
        inputData.assessment,
        inputData.drift,
        inputData.plan,
        inputData.outreach,
      );
      return { ...inputData, terminal };
    },
  });

  const recordAssessmentMonitoring = createStep({
    id: 'record-assessment-monitoring',
    description: 'Persist account risk, drift, recommendation, latency, token, and cost metrics.',
    inputSchema: reviewPipelineSchema,
    outputSchema: preparedRunSchema,
    execute: async ({ inputData }) => {
      if (!inputData.terminal) throw new Error('Review did not produce a terminal preparation result');
      await composition.service.recordAssessmentMonitoring(
        inputData.initialization,
        inputData.terminal,
        Math.max(0, Date.now() - inputData.initialization.startedAtMs),
      );
      return inputData.terminal;
    },
  });

  const requestApproval = createStep({
    id: 'request-csm-approval',
    description: 'Suspend risky-account execution until a CSM approves or rejects the bound artifacts.',
    inputSchema: preparedRunSchema,
    outputSchema: approvalStepOutputSchema,
    resumeSchema: approvalResumeSchema,
    suspendSchema: approvalRequestSchema,
    execute: async ({ inputData, resumeData, suspend, requestContext }) => {
      if (inputData.outcome !== 'awaiting_approval') {
        return { prepared: inputData, decision: null, startedAtMs: Date.now() };
      }
      const request = await composition.operationalStore.getRequest(inputData.runId);
      if (!request) throw new Error(`Approval request ${inputData.runId} was not persisted`);
      if (!resumeData) {
        return suspend(request);
      }
      const contextApprover = requestContext.get('csm-id');
      if (contextApprover && contextApprover !== resumeData.approverId) {
        throw new Error('approver RequestContext mismatch');
      }
      const decision = approvalDecisionSchema.parse({
        ...resumeData,
        decidedAt: composition.service.now(),
        expiresAt: request.expiresAt,
        boundToHash: request.artifactHash,
        boundToAsOf: request.artifactAsOf,
      });
      return { prepared: inputData, decision, startedAtMs: Date.now() };
    },
  });

  const validateApproval = createStep({
    id: 'validate-approval-freshness',
    description: 'Re-read sources and reject expired, mismatched, or stale approvals before CRM writes.',
    inputSchema: approvalStepOutputSchema,
    outputSchema: approvalValidationSchema,
    retries: 2,
    execute: async ({ inputData }) => {
      if (!inputData.decision) {
        return {
          ...inputData,
          run: inputData.prepared,
          writeInput: null,
        };
      }
      const validation = await composition.service.validateApproval(inputData.prepared, inputData.decision);
      return { ...inputData, ...validation };
    },
  });

  const writeTasks = createStep({
    id: 'create-crm-follow-up-tasks',
    description: 'Create one idempotent CRM task for every approved account-plan action.',
    inputSchema: approvalValidationSchema,
    outputSchema: taskWriteStageSchema,
    retries: 2,
    execute: async ({ inputData }) => ({
      ...inputData,
      tasks: inputData.writeInput ? await composition.service.writeApprovedTasks(inputData.writeInput) : null,
    }),
  });

  const writeNote = createStep({
    id: 'create-crm-internal-note',
    description: 'Create the approved internal-only CRM note containing the review and outreach draft.',
    inputSchema: taskWriteStageSchema,
    outputSchema: noteWriteStageSchema,
    retries: 2,
    execute: async ({ inputData }) => {
      if (!inputData.writeInput) return { ...inputData, note: null };
      if (!inputData.tasks) throw new Error('CRM tasks must complete before the internal note');
      const note = await composition.service.writeApprovedNote(inputData.writeInput);
      return {
        ...inputData,
        note,
        run: composition.service.completeApprovedWrite(inputData.run, inputData.tasks, note),
      };
    },
  });

  const recordApprovalMonitoring = createStep({
    id: 'record-approval-monitoring',
    description: 'Persist approval, recommendation acceptance, feedback, write, and latency metrics.',
    inputSchema: noteWriteStageSchema,
    outputSchema: accountRunOutputSchema,
    execute: async ({ inputData }) => {
      if (inputData.decision) {
        await composition.service.recordApprovalMonitoring(
          inputData.prepared,
          inputData.decision,
          inputData.run,
          Math.max(0, Date.now() - inputData.startedAtMs),
        );
      }
      return {
        ...inputData.run,
        writeId: inputData.note?.writeId ?? null,
        created: inputData.note?.created ?? null,
        taskIds: inputData.tasks?.taskIds ?? [],
        tasksCreated: inputData.tasks?.createdCount ?? null,
        tasksReused: inputData.tasks?.existingCount ?? null,
      };
    },
  });

  return createWorkflow({
    id: 'customer-success-account',
    inputSchema: accountRunInputSchema,
    outputSchema: accountRunOutputSchema,
  })
    .then(initializeReview)
    .parallel([readUsage, readSupport, readBilling, readCrm])
    .then(assembleSnapshot)
    .then(assessHealth)
    .then(calculateDrift)
    .then(createPlan)
    .then(draftOutreach)
    .then(bindArtifacts)
    .then(recordAssessmentMonitoring)
    .then(requestApproval)
    .then(validateApproval)
    .then(writeTasks)
    .then(writeNote)
    .then(recordApprovalMonitoring)
    .commit();
}
