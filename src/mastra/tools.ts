import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { CustomerDataSource } from './data.js';
import type { ReviewHistory } from './history.js';
import { accountSignalsSchema, reviewSchema } from './schemas.js';
export function createCustomerTools(data: CustomerDataSource, history: ReviewHistory) {
  const listAccounts = createTool({
    id: 'list-customer-accounts',
    description: 'List the customer accounts available for renewal review.',
    inputSchema: z.object({}),
    outputSchema: z.array(accountSignalsSchema),
    execute: () => data.listAccounts(),
  });
  const getCustomerSignals = createTool({
    id: 'get-customer-signals',
    description: 'Get normalized usage, support, billing, and CRM signals for one account.',
    inputSchema: z.object({ accountId: z.string() }),
    outputSchema: accountSignalsSchema.nullable(),
    execute: ({ accountId }) => data.getAccount(accountId),
  });
  const saveApprovedReview = createTool({
    id: 'save-approved-review',
    description: 'Save a human-approved review as an internal CRM note. Never sends outreach.',
    inputSchema: reviewSchema,
    outputSchema: z.object({ writeId: z.string(), taskIds: z.array(z.string()) }),
    requireApproval: true,
    execute: async (review) => {
      await history.record(review);
      return history.writeOnce(review.runId, () => data.saveReview(review));
    },
  });
  const getMonitoring = createTool({
    id: 'get-customer-success-monitoring',
    description: 'Summarize persisted account reviews, approvals, costs, latency, feedback, and alerts.',
    inputSchema: z.object({ accountId: z.string().optional() }),
    outputSchema: z.object({
      reviews: z.number(),
      acceptedRecommendations: z.number(),
      outreachApprovals: z.number(),
      humanFeedback: z.number(),
      averageLatencyMs: z.number(),
      totalCostUsd: z.number(),
      alerts: z.array(z.string()),
    }),
    execute: ({ accountId }) => history.dashboard(accountId),
  });
  return { listAccounts, getCustomerSignals, saveApprovedReview, getMonitoring };
}
