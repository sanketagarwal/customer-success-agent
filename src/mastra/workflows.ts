import { randomUUID } from 'node:crypto';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { AppConfig } from './config.js';
import type { Connectors } from './connectors.js';
import { prepareReview, snapshotHash, type Reviewer, type Usage } from './review.js';
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
import type { State } from './state.js';

export const accountInputSchema = z.object({
  accountId: z.string().min(1).default('340734348989').describe('CRM account ID'),
});
export const approvalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  approverId: z.string().min(1),
  feedback: z.string().max(4000).optional(),
});

const usageSchema = z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() });
const stateBase = z.object({
  runId: z.string(),
  tenantId: z.string(),
  accountId: z.string(),
  startedAt: z.number(),
  snapshot: snapshotSchema,
  review: reviewSchema.nullable(),
  outcome: outcomeSchema.nullable(),
  message: z.string(),
  approval: approvalSchema.nullable(),
  usage: usageSchema,
  crm: crmWriteSchema.nullable(),
});
const stateSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const snapshot = snapshotSchema.safeParse(source.snapshot);
  if (!snapshot.success || source.review == null) return snapshot.success ? { ...source, snapshot: snapshot.data } : value;
  const review = reviewSchema.safeParse(source.review);
  return review.success
    ? { ...source, snapshot: snapshot.data, review: { ...review.data, sourceHash: snapshotHash(snapshot.data) } }
    : value;
}, stateBase);
type WorkflowState = z.infer<typeof stateSchema>;

const approvalRequestSchema = z.object({
  accountId: z.string(),
  health: z.string(),
  riskScore: z.number(),
  risks: z.array(z.string()),
  actions: z.array(z.string()),
  outreachSubject: z.string(),
  outreachBody: z.string(),
  expiresAt: z.string(),
});

export interface WorkflowDependencies {
  config: Pick<AppConfig, 'tenantId' | 'cron' | 'timezone'>;
  connectors: Connectors;
  reviewer: Reviewer;
  state: State;
  now(): Date;
}

const windowFor = (asOf: string) => ({
  start: new Date(Date.parse(asOf) - 28 * 86_400_000).toISOString(),
  end: asOf,
});
const unavailable = (snapshot: Snapshot) => [snapshot.usage, snapshot.support, snapshot.billing, snapshot.crm]
  .some(result => result.status === 'unavailable');

export async function collectAccountData(
  connectors: Connectors,
  tenantId: string,
  accountId: string,
  window = windowFor(new Date().toISOString()),
) {
  const query = { tenantId, accountId, window };
  const safe = async <T>(provider: string, read: () => Promise<T>) => {
    try {
      return await read();
    } catch (error) {
      return { status: 'unavailable' as const, error: `${provider}: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const [usage, support, billing, crm] = await Promise.all([
    safe('usage', () => connectors.readUsage(query)),
    safe('support', () => connectors.readSupport(query)),
    safe('billing', () => connectors.readBilling(query)),
    safe('crm', () => connectors.readCrmNotes(query)),
  ]);
  return snapshotSchema.parse({ tenantId, accountId, window, usage, support, billing, crm });
}

function finish(state: WorkflowState): WorkflowOutput {
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

function event(state: WorkflowState, phase: MonitoringEvent['phase'], usage: Usage): MonitoringEvent {
  const approved = phase === 'approval' && state.outcome === 'written';
  return {
    runId: state.runId,
    accountId: state.accountId,
    phase,
    outcome: state.outcome ?? 'unknown_retry',
    riskScore: state.review?.assessment.score ?? null,
    scoreDelta: state.review?.drift.scoreDelta ?? null,
    recommendations: state.review?.plan.actions.length ?? 0,
    acceptedRecommendations: approved ? state.review?.plan.actions.length ?? 0 : 0,
    outreachApproved: approved,
    feedback: Boolean(state.approval?.feedback?.trim()),
    ...usage,
    latencyMs: Date.now() - state.startedAt,
    recordedAt: new Date().toISOString(),
  };
}

const initialState = (dependencies: WorkflowDependencies, runId: string, snapshot: Snapshot): WorkflowState => ({
  runId,
  tenantId: dependencies.config.tenantId,
  accountId: snapshot.accountId,
  startedAt: Date.now(),
  snapshot,
  review: null,
  outcome: null,
  message: '',
  approval: null,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  crm: null,
});

async function analyze(input: WorkflowState, dependencies: WorkflowDependencies) {
  let next = input;
  const sources = [input.snapshot.usage, input.snapshot.support, input.snapshot.billing, input.snapshot.crm];
  if (sources.some(result => result.status === 'unavailable')) {
    next = { ...next, outcome: 'unknown_retry', message: 'A source remained unavailable after retries.' };
  } else if (sources.filter(result => result.status === 'available').length < 2) {
    next = { ...next, outcome: 'insufficient_data', message: 'At least two data sources are required.' };
  } else {
    const previous = await dependencies.state.getReview(input.tenantId, input.accountId);
    const prepared = await prepareReview(input.snapshot, dependencies.reviewer, previous);
    const outcome = prepared.issues.length
      ? 'grounding_failed'
      : prepared.review.assessment.status === 'healthy' ? 'no_action' : 'awaiting_approval';
    next = {
      ...next,
      review: prepared.review,
      usage: prepared.usage,
      outcome,
      message: outcome === 'grounding_failed'
        ? `Unsupported evidence: ${prepared.issues.join(', ')}`
        : outcome === 'no_action' ? 'Account is healthy; no follow-up is needed.' : 'Review is ready for CSM approval.',
    };
    await dependencies.state.saveReview(input.tenantId, input.accountId, prepared.review);
  }
  await dependencies.state.record(input.tenantId, event(next, 'review', next.usage));
  return stateSchema.parse(next);
}

export function createAccountWorkflow(dependencies: WorkflowDependencies) {
  const collect = createStep({
    id: 'collect-account-data',
    description: 'Read product usage, support, billing, and CRM notes in parallel.',
    inputSchema: accountInputSchema,
    outputSchema: stateSchema,
    retries: 2,
    execute: async ({ inputData, requestContext, retryCount, runId }) => {
      if (requestContext.get('tenant-id') && requestContext.get('tenant-id') !== dependencies.config.tenantId) {
        throw new Error('RequestContext tenant mismatch');
      }
      if (requestContext.get('account-id') && requestContext.get('account-id') !== inputData.accountId) {
        throw new Error('RequestContext account mismatch');
      }
      const snapshot = await collectAccountData(
        dependencies.connectors,
        dependencies.config.tenantId,
        inputData.accountId,
        windowFor(dependencies.now().toISOString()),
      );
      if (unavailable(snapshot) && retryCount < 2) throw new Error('A source is temporarily unavailable');
      return initialState(dependencies, runId, snapshot);
    },
  });

  const prepare = createStep({
    id: 'prepare-account-review',
    description: 'Create the health assessment, risks, account plan, drift, and outreach draft.',
    inputSchema: stateSchema,
    outputSchema: stateSchema,
    retries: 2,
    execute: ({ inputData }) => analyze(inputData, dependencies),
  });

  const approve = createStep({
    id: 'request-csm-approval',
    description: 'Pause risky accounts for CSM approval.',
    inputSchema: stateSchema,
    outputSchema: stateSchema,
    resumeSchema: approvalSchema,
    suspendSchema: approvalRequestSchema,
    execute: async ({ inputData, resumeData, requestContext, suspend }) => {
      if (inputData.outcome !== 'awaiting_approval' || !inputData.review) return inputData;
      if (!resumeData) return suspend({
        accountId: inputData.accountId,
        health: inputData.review.assessment.status,
        riskScore: inputData.review.assessment.score,
        risks: inputData.review.assessment.risks.map(risk => risk.title),
        actions: inputData.review.plan.actions.map(action => action.title),
        outreachSubject: inputData.review.outreach.subject,
        outreachBody: inputData.review.outreach.body,
        expiresAt: new Date(Date.parse(inputData.review.asOf) + 7 * 86_400_000).toISOString(),
      });
      if (requestContext.get('csm-id') && requestContext.get('csm-id') !== resumeData.approverId) {
        throw new Error('RequestContext approver mismatch');
      }
      const next = resumeData.decision === 'approved'
        ? { ...inputData, approval: resumeData }
        : { ...inputData, approval: resumeData, outcome: 'rejected' as const, message: 'CSM rejected the draft; CRM was not updated.' };
      if (next.outcome === 'rejected') {
        await dependencies.state.record(next.tenantId, event(next, 'approval', { inputTokens: 0, outputTokens: 0, costUsd: 0 }));
      }
      return next;
    },
  });

  const write = createStep({
    id: 'update-crm-and-schedule-follow-ups',
    description: 'Write the approved CRM note and follow-up tasks exactly once.',
    inputSchema: stateSchema,
    outputSchema: workflowOutputSchema,
    retries: 2,
    execute: async ({ inputData }) => {
      if (inputData.outcome !== 'awaiting_approval' || inputData.approval?.decision !== 'approved' || !inputData.review) {
        return finish(inputData);
      }
      const current = await collectAccountData(
        dependencies.connectors,
        inputData.tenantId,
        inputData.accountId,
        { start: inputData.snapshot.window.start, end: dependencies.now().toISOString() },
      );
      let next: WorkflowState;
      if (dependencies.now().getTime() > Date.parse(inputData.review.asOf) + 7 * 86_400_000
        || snapshotHash(current) !== inputData.review.sourceHash) {
        next = { ...inputData, outcome: 'stale_approval', message: 'Account data changed; run a new review before writing to CRM.' };
      } else {
        const crm = await dependencies.connectors.writeToCrm({
          tenantId: inputData.tenantId,
          accountId: inputData.accountId,
          runId: inputData.runId,
          review: inputData.review,
        });
        next = { ...inputData, crm, outcome: 'written', message: 'Approved CRM note and follow-up tasks were created.' };
      }
      await dependencies.state.record(next.tenantId, event(next, 'approval', { inputTokens: 0, outputTokens: 0, costUsd: 0 }));
      return finish(next);
    },
  });

  return createWorkflow({ id: 'customer-success-account', inputSchema: accountInputSchema, outputSchema: workflowOutputSchema })
    .then(collect).then(prepare).then(approve).then(write).commit();
}

const scheduledOutputSchema = z.object({
  total: z.number(),
  results: z.array(z.object({ accountId: z.string(), runId: z.string(), outcome: z.string(), error: z.string().nullable() })),
});

async function mapConcurrent<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      if (items[index] !== undefined) results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

export async function executeScheduledReviews(dependencies: WorkflowDependencies) {
  const accounts = await dependencies.connectors.listAccounts(dependencies.config.tenantId);
  const results = await mapConcurrent(accounts, 4, async account => {
    const runId = `scheduled-${account.accountId}-${randomUUID()}`;
    try {
      const window = windowFor(dependencies.now().toISOString());
      let snapshot = await collectAccountData(dependencies.connectors, dependencies.config.tenantId, account.accountId, window);
      for (let attempt = 1; attempt < 3 && unavailable(snapshot); attempt += 1) {
        snapshot = await collectAccountData(dependencies.connectors, dependencies.config.tenantId, account.accountId, window);
      }
      const state = await analyze(initialState(dependencies, runId, snapshot), dependencies);
      return { accountId: account.accountId, runId, outcome: state.outcome ?? 'failed', error: null };
    } catch (error) {
      return { accountId: account.accountId, runId, outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  });
  return { total: results.length, results };
}

export function createScheduledWorkflow(dependencies: WorkflowDependencies) {
  const reviewAccounts = createStep({
    id: 'review-all-accounts',
    description: 'Prepare an isolated review for every CRM account.',
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
