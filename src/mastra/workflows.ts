import { randomUUID } from 'node:crypto';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { AppConfig } from './config.js';
import type { CustomerSuccessConnectors } from './connectors.js';
import { prepareReview, snapshotHash } from './customer-success.js';
import type { Reviewer, Usage } from './reviewer.js';
import {
  crmWriteSchema,
  outcomeSchema,
  reviewSchema,
  snapshotSchema,
  workflowOutputSchema,
  type MonitoringEvent,
  type Snapshot,
  type WorkflowOutput,
} from './schemas.js';
import type { CustomerSuccessState } from './state.js';

export const accountInputSchema = z.object({
  accountId: z.string().min(1).default('340734348989').describe('CRM account ID'),
});

export const approvalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  approverId: z.string().min(1),
  feedback: z.string().max(4000).optional(),
});

const usageSchema = z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() });
const stateSchema = z.object({
  runId: z.string(),
  tenantId: z.string(),
  accountId: z.string(),
  asOf: z.string(),
  startedAt: z.number(),
  snapshot: snapshotSchema,
  review: reviewSchema.nullable(),
  outcome: outcomeSchema.nullable(),
  message: z.string(),
  approval: approvalSchema.nullable(),
  usage: usageSchema,
  crm: crmWriteSchema.nullable(),
});

const approvalRequestSchema = z.object({
  accountId: z.string(),
  health: z.string(),
  riskScore: z.number(),
  riskFactors: z.array(z.string()),
  plan: z.array(z.string()),
  outreachSubject: z.string(),
  outreachBody: z.string(),
  expiresAt: z.string(),
});

export interface WorkflowDependencies {
  config: Pick<AppConfig, 'tenantId' | 'cron' | 'timezone' | 'maxAccountConcurrency'>;
  connectors: CustomerSuccessConnectors;
  reviewer: Reviewer;
  state: CustomerSuccessState;
  now(): Date;
}

const assessmentWindow = (asOf: string) => ({
  start: new Date(Date.parse(asOf) - 28 * 86_400_000).toISOString(),
  end: asOf,
});

async function safeRead<T>(read: () => Promise<T>, provider: string) {
  try {
    return await read();
  } catch (error) {
    return { status: 'unavailable' as const, error: `${provider}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function collectAccountData(
  connectors: CustomerSuccessConnectors,
  tenantId: string,
  accountId: string,
  window = assessmentWindow(new Date().toISOString()),
) {
  const query = { tenantId, accountId, window };
  const [usage, support, billing, crm] = await Promise.all([
    safeRead(() => connectors.readUsage(query), 'usage'),
    safeRead(() => connectors.readSupport(query), 'support'),
    safeRead(() => connectors.readBilling(query), 'billing'),
    safeRead(() => connectors.readCrmNotes(query), 'crm'),
  ]);
  return snapshotSchema.parse({ tenantId, accountId, window, usage, support, billing, crm });
}

function output(state: z.infer<typeof stateSchema>): WorkflowOutput {
  if (!state.outcome) throw new Error('Workflow finished without an outcome');
  return workflowOutputSchema.parse({
    runId: state.runId,
    accountId: state.accountId,
    outcome: state.outcome,
    review: state.review,
    crm: state.crm,
    message: state.message,
  });
}

function event(
  state: z.infer<typeof stateSchema>,
  phase: MonitoringEvent['phase'],
  usage: Usage,
): MonitoringEvent {
  const approved = phase === 'approval' && state.outcome === 'written';
  return {
    runId: state.runId,
    tenantId: state.tenantId,
    accountId: state.accountId,
    phase,
    outcome: state.outcome ?? 'unknown_retry',
    riskScore: state.review?.assessment.score ?? null,
    scoreDelta: state.review?.drift.scoreDelta ?? null,
    recommendations: state.review?.plan.actions.length ?? 0,
    acceptedRecommendations: approved ? (state.review?.plan.actions.length ?? 0) : 0,
    outreachApproved: approved,
    feedback: Boolean(state.approval?.feedback?.trim()),
    ...usage,
    latencyMs: Math.max(0, Date.now() - state.startedAt),
    recordedAt: new Date().toISOString(),
  };
}

function initialState(dependencies: WorkflowDependencies, accountId: string, runId: string, snapshot: Snapshot) {
  return stateSchema.parse({
    runId,
    tenantId: dependencies.config.tenantId,
    accountId,
    asOf: snapshot.window.end,
    startedAt: Date.now(),
    snapshot,
    review: null,
    outcome: null,
    message: '',
    approval: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    crm: null,
  });
}

async function analyzeAccount(input: z.infer<typeof stateSchema>, dependencies: WorkflowDependencies) {
  const results = [input.snapshot.usage, input.snapshot.support, input.snapshot.billing, input.snapshot.crm];
  let next = input;
  if (results.some(result => result.status === 'unavailable')) {
    next = { ...next, outcome: 'unknown_retry' as const, message: 'A source remained unavailable after retries.' };
  } else if (results.filter(result => result.status === 'available').length < 2) {
    next = { ...next, outcome: 'insufficient_data' as const, message: 'At least two data sources are required.' };
  } else {
    const previous = await dependencies.state.getReview(input.tenantId, input.accountId);
    const prepared = await prepareReview(input.snapshot, dependencies.reviewer, previous);
    next = { ...next, review: prepared.review, usage: prepared.usage };
    if (prepared.errors.length) {
      next = { ...next, outcome: 'grounding_failed' as const, message: `Unsupported evidence: ${prepared.errors.join(', ')}` };
    } else if (prepared.review.assessment.status === 'healthy') {
      next = { ...next, outcome: 'no_action' as const, message: 'Account is healthy; no follow-up is needed.' };
    } else {
      next = { ...next, outcome: 'awaiting_approval' as const, message: 'Review is ready for CSM approval.' };
    }
    await dependencies.state.saveReview(prepared.review);
  }
  await dependencies.state.record(event(next, 'review', next.usage));
  return next;
}

export function createAccountWorkflow(dependencies: WorkflowDependencies) {
  const collect = createStep({
    id: 'collect-account-data',
    description: 'Read product usage, support, billing, and CRM notes in parallel.',
    inputSchema: accountInputSchema,
    outputSchema: stateSchema,
    retries: 2,
    execute: async ({ inputData, requestContext, retryCount, runId }) => {
      const tenantId = dependencies.config.tenantId;
      const contextTenant = requestContext.get('tenant-id');
      const contextAccount = requestContext.get('account-id');
      if (contextTenant && contextTenant !== tenantId) throw new Error('RequestContext tenant mismatch');
      if (contextAccount && contextAccount !== inputData.accountId) throw new Error('RequestContext account mismatch');
      const asOf = dependencies.now().toISOString();
      const snapshot = await collectAccountData(
        dependencies.connectors,
        tenantId,
        inputData.accountId,
        assessmentWindow(asOf),
      );
      const unavailable = [snapshot.usage, snapshot.support, snapshot.billing, snapshot.crm]
        .some(result => result.status === 'unavailable');
      if (unavailable && retryCount < 2) throw new Error('A source is temporarily unavailable');
      return initialState(dependencies, inputData.accountId, runId, snapshot);
    },
  });

  const prepare = createStep({
    id: 'prepare-account-review',
    description: 'Create the structured assessment, risk factors, account plan, drift, and outreach draft.',
    inputSchema: stateSchema,
    outputSchema: stateSchema,
    retries: 2,
    execute: ({ inputData }) => analyzeAccount(inputData, dependencies),
  });

  const approve = createStep({
    id: 'request-csm-approval',
    description: 'Pause risky accounts for a simple approve-or-reject decision.',
    inputSchema: stateSchema,
    outputSchema: stateSchema,
    resumeSchema: approvalSchema,
    suspendSchema: approvalRequestSchema,
    execute: async ({ inputData, resumeData, requestContext, suspend }) => {
      if (inputData.outcome !== 'awaiting_approval' || !inputData.review) return inputData;
      if (!resumeData) {
        return suspend({
          accountId: inputData.accountId,
          health: inputData.review.assessment.status,
          riskScore: inputData.review.assessment.score,
          riskFactors: inputData.review.assessment.riskFactors.map(risk => risk.title),
          plan: inputData.review.plan.actions.map(action => action.title),
          outreachSubject: inputData.review.outreach.subject,
          outreachBody: inputData.review.outreach.body,
          expiresAt: new Date(Date.parse(inputData.asOf) + 7 * 86_400_000).toISOString(),
        });
      }
      const contextApprover = requestContext.get('csm-id');
      if (contextApprover && contextApprover !== resumeData.approverId) throw new Error('RequestContext approver mismatch');
      const next = resumeData.decision === 'rejected'
        ? { ...inputData, approval: resumeData, outcome: 'rejected' as const, message: 'CSM rejected the draft; CRM was not updated.' }
        : { ...inputData, approval: resumeData };
      if (next.outcome === 'rejected') await dependencies.state.record(event(next, 'approval', { inputTokens: 0, outputTokens: 0, costUsd: 0 }));
      return next;
    },
  });

  const write = createStep({
    id: 'update-crm-and-schedule-follow-ups',
    description: 'Write the approved CRM note and create follow-up tasks exactly once.',
    inputSchema: stateSchema,
    outputSchema: workflowOutputSchema,
    retries: 2,
    execute: async ({ inputData }) => {
      if (inputData.outcome !== 'awaiting_approval' || inputData.approval?.decision !== 'approved' || !inputData.review) {
        return output(inputData);
      }
      const expiresAt = Date.parse(inputData.asOf) + 7 * 86_400_000;
      const fresh = await collectAccountData(
        dependencies.connectors,
        inputData.tenantId,
        inputData.accountId,
        { start: inputData.snapshot.window.start, end: dependencies.now().toISOString() },
      );
      let next = inputData;
      if (dependencies.now().getTime() > expiresAt || snapshotHash(fresh) !== inputData.review.assessment.sourceHash) {
        next = { ...next, outcome: 'stale_approval' as const, message: 'Account data changed; run a new review before writing to CRM.' };
      } else {
        const crm = await dependencies.connectors.writeToCrm({
          tenantId: inputData.tenantId,
          accountId: inputData.accountId,
          runId: inputData.runId,
          review: inputData.review,
        });
        next = { ...next, crm, outcome: 'written' as const, message: 'Approved CRM note and follow-up tasks were created.' };
      }
      await dependencies.state.record(event(next, 'approval', { inputTokens: 0, outputTokens: 0, costUsd: 0 }));
      return output(next);
    },
  });

  return createWorkflow({ id: 'customer-success-account', inputSchema: accountInputSchema, outputSchema: workflowOutputSchema })
    .then(collect)
    .then(prepare)
    .then(approve)
    .then(write)
    .commit();
}

const scheduledOutputSchema = z.object({
  total: z.number(),
  results: z.array(z.object({
    accountId: z.string(),
    runId: z.string(),
    outcome: z.string(),
    error: z.string().nullable(),
  })),
});

async function mapConcurrent<T, R>(values: readonly T[], limit: number, worker: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value !== undefined) results[index] = await worker(value);
    }
  }));
  return results;
}

export async function executeScheduledReviews(dependencies: WorkflowDependencies) {
  const accounts = await dependencies.connectors.listAccounts(dependencies.config.tenantId);
  const results = await mapConcurrent(accounts, dependencies.config.maxAccountConcurrency, async account => {
    const runId = `scheduled-${account.accountId}-${randomUUID()}`;
    try {
      const asOf = dependencies.now().toISOString();
      let snapshot: Snapshot | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        snapshot = await collectAccountData(
          dependencies.connectors,
          dependencies.config.tenantId,
          account.accountId,
          assessmentWindow(asOf),
        );
        if (![snapshot.usage, snapshot.support, snapshot.billing, snapshot.crm]
          .some(result => result.status === 'unavailable')) break;
      }
      const result = await analyzeAccount(initialState(dependencies, account.accountId, runId, snapshot!), dependencies);
      return { accountId: account.accountId, runId, outcome: result.outcome ?? 'failed', error: null };
    } catch (error) {
      return {
        accountId: account.accountId,
        runId,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return { total: results.length, results };
}

export function createScheduledWorkflow(dependencies: WorkflowDependencies) {
  const reviewAccounts = createStep({
    id: 'review-all-accounts',
    description: 'Prepare an isolated customer-success review for every CRM account.',
    inputSchema: z.object({}),
    outputSchema: scheduledOutputSchema,
    retries: 2,
    execute: () => executeScheduledReviews(dependencies),
  });

  return createWorkflow({
    id: 'weekly-customer-success',
    inputSchema: z.object({}),
    outputSchema: scheduledOutputSchema,
    schedule: {
      cron: dependencies.config.cron,
      timezone: dependencies.config.timezone,
      inputData: {},
      metadata: { purpose: 'weekly renewal-risk review' },
    },
  }).then(reviewAccounts).commit();
}
