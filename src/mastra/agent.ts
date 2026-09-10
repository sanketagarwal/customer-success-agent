import { Agent } from '@mastra/core/agent';
import type { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import type { Config } from './config.js';
import type { createCustomerTools } from './tools.js';

export function createRenewalRiskAgent(
  config: Config,
  storage: LibSQLStore,
  tools: ReturnType<typeof createCustomerTools>,
) {
  return new Agent({
    id: 'customer-renewal-risk-and-recovery',
    name: 'Customer Renewal Risk and Recovery',
    model: config.model,
    tools,
    instructions: `Use the provided tools to inspect customer signals before making claims.
Explain risk with exact signal values and never invent customer context.
Draft concise actions and outreach, but never claim outreach was sent.
Only save a review after explicit human approval.`,
    memory: new Memory({
      storage,
      options: {
        observationalMemory: { model: config.model },
      },
    }),
  });
}
