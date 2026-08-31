import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { CustomerDataSource } from '../data.js';
import type { createAccountWorkflow } from './account.js';
const inputSchema = z.object({});
const resultSchema = z.object({
  accountId: z.string(),
  status: z.enum(['completed', 'awaiting_approval', 'failed']),
  outcome: z.string(),
});
const outputSchema = z.object({ results: z.array(resultSchema) });
export function createScheduledWorkflow(
  data: CustomerDataSource,
  accountWorkflow: ReturnType<typeof createAccountWorkflow>,
  config: Config,
) {
  const reviewPortfolio = createStep({
    id: 'review-customer-portfolio',
    inputSchema,
    outputSchema,
    retries: 2,
    execute: async () => {
      const accounts = await data.listAccounts();
      const results: z.infer<typeof resultSchema>[] = [];
      for (let index = 0; index < accounts.length; index += config.maxConcurrency) {
        const batch = await Promise.all(
          accounts.slice(index, index + config.maxConcurrency).map(async ({ tenantId, accountId }) => {
          try {
            const run = await accountWorkflow.createRun();
            const requestContext = new RequestContext<{ 'tenant-id'?: string | undefined; 'account-id'?: string | undefined }>();
            requestContext.set('tenant-id', tenantId);
            requestContext.set('account-id', accountId);
            const result = await run.start({ inputData: { accountId }, requestContext });
            if (result.status === 'success') {
              return { accountId, status: 'completed' as const, outcome: result.result.outcome };
            }
            if (result.status === 'suspended') return {
              accountId, status: 'awaiting_approval' as const, outcome: 'awaiting_approval',
            };
            return { accountId, status: 'failed' as const, outcome: result.status };
          } catch {
            return { accountId, status: 'failed' as const, outcome: 'failed' };
          }
          }),
        );
        results.push(...batch);
      }
      return { results };
    },
  });
  return createWorkflow({
    id: 'weekly-customer-success', inputSchema, outputSchema,
    schedule: { cron: config.cron, timezone: config.timezone, inputData: {} },
  }).then(reviewPortfolio).commit();
}
