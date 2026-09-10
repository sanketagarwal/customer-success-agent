import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { CustomerDataSource } from '../data.js';
import type { createAccountWorkflow } from './account.js';

const inputSchema = z.object({});
const resultSchema = z.object({
  accountId: z.string(),
  runId: z.string().nullable().optional(),
  status: z.enum(['completed', 'awaiting_approval', 'failed']),
  outcome: z.string(),
});
const outputSchema = z.object({ results: z.array(resultSchema) });

type AccountWorkflow = ReturnType<typeof createAccountWorkflow>;
type PortfolioResult = z.infer<typeof resultSchema>;
type CustomerRequestContext = {
  'tenant-id'?: string | undefined;
  'account-id'?: string | undefined;
};

async function reviewAccount(
  accountWorkflow: AccountWorkflow,
  tenantId: string,
  accountId: string,
): Promise<PortfolioResult> {
  let runId: string | null = null;
  try {
    const run = await accountWorkflow.createRun();
    runId = run.runId;
    const requestContext = new RequestContext<CustomerRequestContext>();
    requestContext.set('tenant-id', tenantId);
    requestContext.set('account-id', accountId);

    const result = await run.start({ inputData: { accountId }, requestContext });

    if (result.status === 'success') {
      return { accountId, runId, status: 'completed', outcome: result.result.outcome };
    }

    if (result.status === 'suspended') {
      return {
        accountId,
        runId,
        status: 'awaiting_approval',
        outcome: 'awaiting_approval',
      };
    }

    return { accountId, runId, status: 'failed', outcome: result.status };
  } catch {
    return { accountId, runId, status: 'failed', outcome: 'failed' };
  }
}

export function createScheduledWorkflow(
  data: CustomerDataSource,
  accountWorkflow: AccountWorkflow,
  config: Config,
  options: { id?: string; scheduled?: boolean } = {},
) {
  const reviewPortfolio = createStep({
    id: 'review-customer-portfolio',
    inputSchema,
    outputSchema,
    retries: 2,
    execute: async () => {
      const accounts = await data.listAccounts();
      const results: PortfolioResult[] = [];

      for (let index = 0; index < accounts.length; index += config.maxConcurrency) {
        const batch = await Promise.all(
          accounts
            .slice(index, index + config.maxConcurrency)
            .map(({ tenantId, accountId }) =>
              reviewAccount(accountWorkflow, tenantId, accountId),
            ),
        );

        results.push(...batch);
      }

      return { results };
    },
  });

  return createWorkflow({
    id: options.id ?? 'weekly-renewal-review',
    inputSchema,
    outputSchema,
    ...(options.scheduled === false ? {} : {
      schedule: { cron: config.cron, timezone: config.timezone, inputData: {} },
    }),
  })
    .then(reviewPortfolio)
    .commit();
}
