import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { z } from 'zod';

import type { AppConfig } from './config.js';
import { createConnectors, type Connectors } from './connectors.js';
import { createAgent, ModelReviewer, type Reviewer } from './review.js';
import { accountSchema, crmWriteSchema, notesResultSchema, reviewSchema, windowSchema } from './schemas.js';
import { LibSqlState, type State } from './state.js';
import { createAccountWorkflow, createScheduledWorkflow } from './workflows.js';

export function createRuntime(config: AppConfig, overrides: {
  connectors?: Partial<Connectors>;
  reviewer?: Reviewer;
  state?: State;
} = {}) {
  const storage = new LibSQLStore({
    id: 'customer-success-storage',
    url: config.databaseUrl,
  });
  const vector = config.semanticRecall ? new LibSQLVector({
    id: 'customer-success-vector',
    url: config.databaseUrl,
  }) : undefined;
  const agent = createAgent({
    model: config.model,
    storage,
    observationalMemory: config.observationalMemory,
    ...(vector ? { vector, embedder: new ModelRouterEmbeddingModel(config.embeddingModel) } : {}),
  });
  const state = overrides.state ?? new LibSqlState(config.databaseUrl);
  const connectors = createConnectors(config, state, overrides.connectors);
  const reviewer = overrides.reviewer ?? new ModelReviewer(
    agent,
    config.modelInputCostPerMillion,
    config.modelOutputCostPerMillion,
  );
  const dependencies = {
    config,
    connectors,
    reviewer,
    state,
    now: () => config.crmProvider === 'fixture' ? new Date(config.fixtureNow) : new Date(),
  };
  const accountWorkflow = createAccountWorkflow(dependencies);
  const scheduledWorkflow = createScheduledWorkflow(dependencies);
  const tools = {
    listCustomerAccounts: createTool({
      id: 'list-customer-accounts',
      description: 'List accounts from the configured CRM.',
      inputSchema: z.object({ tenantId: z.string() }),
      outputSchema: z.array(accountSchema),
      execute: ({ tenantId }) => connectors.listAccounts(tenantId).then(accounts => [...accounts]),
    }),
    readCustomerCrmNotes: createTool({
      id: 'read-customer-crm-notes',
      description: 'Read CRM notes for one account and time window.',
      inputSchema: z.object({ tenantId: z.string(), accountId: z.string(), window: windowSchema }),
      outputSchema: notesResultSchema,
      execute: input => connectors.readCrmNotes(input),
    }),
    writeApprovedCustomerSuccessReview: createTool({
      id: 'write-approved-customer-success-review',
      description: 'Write an approved review and follow-up tasks to the configured CRM.',
      inputSchema: z.object({ tenantId: z.string(), accountId: z.string(), runId: z.string(), review: reviewSchema }),
      outputSchema: crmWriteSchema,
      requireApproval: true,
      execute: input => connectors.writeToCrm(input),
    }),
  };
  return { storage, agent, connectors, reviewer, state, accountWorkflow, scheduledWorkflow, tools };
}
