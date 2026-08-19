import { randomUUID } from 'node:crypto';

import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { Composition } from '../composition/create-composition.js';
import type { createAccountWorkflow } from './account-workflow.js';

const scheduledInputSchema = z.object({
  tenantId: z.string().min(1),
  asOf: z.iso.datetime({ offset: true }).optional(),
});

const accountBatchResultSchema = z.object({
  accountId: z.string(),
  runId: z.string(),
  status: z.enum(['success', 'failed', 'suspended', 'paused', 'tripwire']),
  outcome: z.string(),
  error: z.string().nullable(),
});

const scheduledOutputSchema = z.object({
  tenantId: z.string(),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  retryable: z.number().int().nonnegative(),
  results: z.array(accountBatchResultSchema),
});

type ScheduledWorkflowDependencies = Pick<Composition, 'crm'> & {
  config: Pick<
    Composition['config'],
    'maxAccountConcurrency' | 'cron' | 'timezone' | 'tenantId'
  >;
};

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  async function consume(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value !== undefined) output[index] = await worker(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return output;
}

export function createScheduledWorkflow(
  composition: ScheduledWorkflowDependencies,
  accountWorkflow: ReturnType<typeof createAccountWorkflow>,
) {
  const fanOut = createStep({
    id: 'fan-out-account-reviews',
    description:
      'List tenant accounts and run isolated customer-success reviews with bounded concurrency.',
    inputSchema: scheduledInputSchema,
    outputSchema: scheduledOutputSchema,
    retries: 2,
    execute: ({ inputData }) =>
      executeScheduledAccountReviews(composition, accountWorkflow, inputData),
  });

  return createWorkflow({
    id: 'weekly-customer-success',
    inputSchema: scheduledInputSchema,
    outputSchema: scheduledOutputSchema,
    schedule: {
      cron: composition.config.cron,
      timezone: composition.config.timezone,
      inputData: { tenantId: composition.config.tenantId },
      metadata: { purpose: 'weekly customer renewal and churn-risk review' },
    },
  })
    .then(fanOut)
    .commit();
}

export async function executeScheduledAccountReviews(
  composition: ScheduledWorkflowDependencies,
  accountWorkflow: ReturnType<typeof createAccountWorkflow>,
  inputData: z.infer<typeof scheduledInputSchema>,
): Promise<z.infer<typeof scheduledOutputSchema>> {
  const accounts = await composition.crm.listAccounts(inputData.tenantId);
  const results = await mapWithConcurrency(
    accounts,
    composition.config.maxAccountConcurrency,
    async (account) => {
      const runId = `scheduled-${account.accountId}-${randomUUID()}`;
      try {
        const run = await accountWorkflow.createRun({ runId });
        const requestContext = new RequestContext();
        requestContext.set('tenant-id', account.tenantId);
        requestContext.set('account-id', account.accountId);
        const result = await run.start({
          inputData: {
            runId,
            tenantId: account.tenantId,
            accountId: account.accountId,
            ...(inputData.asOf ? { asOf: inputData.asOf } : {}),
          },
          requestContext,
        });
        const outcome =
          result.status === 'success'
            ? result.result.outcome
            : result.status === 'suspended'
              ? 'awaiting_approval'
              : 'unknown_retry';
        return {
          accountId: account.accountId,
          runId,
          status: result.status,
          outcome,
          error: null,
        };
      } catch (error) {
        return {
          accountId: account.accountId,
          runId,
          status: 'failed' as const,
          outcome: 'unknown_retry',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  return {
    tenantId: inputData.tenantId,
    total: results.length,
    succeeded: results.filter(
      (result) => result.status === 'success' || result.status === 'suspended',
    ).length,
    retryable: results.filter((result) => result.outcome === 'unknown_retry').length,
    results,
  };
}
