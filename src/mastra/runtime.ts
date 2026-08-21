import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { z } from 'zod';

import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { createConnectors, type CustomerSuccessConnectors } from './connectors.js';
import { FixtureReviewer, ModelReviewer, createCustomerSuccessAgent, type Reviewer } from './reviewer.js';
import {
  accountSchema,
  crmWriteSchema,
  notesResultSchema,
  reviewSchema,
  windowSchema,
} from './schemas.js';
import { LibSqlState, type CustomerSuccessState } from './state.js';
import { createAccountWorkflow, createScheduledWorkflow } from './workflows.js';

export function createRuntime(
  config: AppConfig,
  overrides: { connectors?: Partial<CustomerSuccessConnectors>; reviewer?: Reviewer; state?: CustomerSuccessState } = {},
) {
  const storage = new LibSQLStore({
    id: 'customer-success-storage',
    url: config.databaseUrl,
    ...(config.tursoAuthToken ? { authToken: config.tursoAuthToken } : {}),
  });
  const vector = config.semanticRecall
    ? new LibSQLVector({
        id: 'customer-success-vector',
        url: config.databaseUrl,
        ...(config.tursoAuthToken ? { authToken: config.tursoAuthToken } : {}),
      })
    : undefined;
  const agent = createCustomerSuccessAgent({
    model: config.model,
    storage,
    ...(vector ? { vector, embedder: new ModelRouterEmbeddingModel(config.embeddingModel) } : {}),
    observationalMemory: config.observationalMemory,
  });
  const connectors = createConnectors(config, overrides.connectors);
  const state = overrides.state ?? new LibSqlState(config.databaseUrl, config.tursoAuthToken);
  const reviewer = overrides.reviewer ?? (config.generationMode === 'fixture'
    ? new FixtureReviewer()
    : new ModelReviewer(agent, config.modelInputCostPerMillion, config.modelOutputCostPerMillion));
  const dependencies = {
    config,
    connectors,
    state,
    reviewer,
    now: () => config.crmProvider === 'fixture' ? new Date(config.fixtureNow) : new Date(),
  };
  const accountWorkflow = createAccountWorkflow(dependencies);
  const scheduledWorkflow = createScheduledWorkflow(dependencies, accountWorkflow);

  const tools = {
    listCustomerAccounts: createTool({
      id: 'list-customer-accounts',
      description: 'List accounts from the configured CRM.',
      inputSchema: z.object({ tenantId: z.string() }),
      outputSchema: z.array(accountSchema),
      execute: async ({ tenantId }) => [...await connectors.listAccounts(tenantId)],
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

  return { config, storage, agent, connectors, state, reviewer, accountWorkflow, scheduledWorkflow, tools };
}

export async function createFixtureRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-customer-success-'));
  const config = loadConfig({
    CRM_PROVIDER: 'fixture',
    GENERATION_MODE: 'fixture',
    FIXTURE_PATH: resolve('data/fixtures/accounts.json'),
    MASTRA_DB_URL: `file:${join(directory, 'runtime.db')}`,
  });
  const runtime = createRuntime(config);
  const mastra = new Mastra({
    storage: runtime.storage,
    workflows: {
      customerSuccessAccountWorkflow: runtime.accountWorkflow,
      weeklyCustomerSuccessWorkflow: runtime.scheduledWorkflow,
    },
  });
  await mastra.getStorage()?.init();
  let closed = false;
  return {
    ...runtime,
    mastra,
    async cleanup() {
      if (closed) return;
      closed = true;
      runtime.state.close?.();
      await mastra.getStorage()?.close();
      await runtime.storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
