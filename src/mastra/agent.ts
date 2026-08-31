import { Agent } from '@mastra/core/agent';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { LibSQLVector, type LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import type { Config } from './config.js';
import type { createCustomerTools } from './tools.js';
export function createCustomerSuccessAgent(config: Config, storage: LibSQLStore,
  tools: ReturnType<typeof createCustomerTools>) {
  const vector = config.semanticRecall
    ? new LibSQLVector({ id: 'customer-success-vectors', url: config.databaseUrl, ...(config.tursoAuthToken ? { authToken: config.tursoAuthToken } : {}) })
    : undefined;
  return new Agent({
    id: 'customer-success-agent',
    name: 'Customer Success Renewal Agent',
    model: config.model,
    tools,
    instructions: [
      'Use the provided tools to inspect customer signals before making claims.',
      'Explain risk with exact signal values and never invent customer context.',
      'Draft concise actions and outreach, but never claim outreach was sent.',
      'Only save a review after explicit human approval.',
    ].join(' '),
    memory: new Memory({
      storage,
      ...(vector
        ? { vector, embedder: new ModelRouterEmbeddingModel(config.embeddingModel) }
        : {}),
      options: {
        lastMessages: 10,
        semanticRecall: vector ? { topK: 3, messageRange: 1, scope: 'resource' } : false,
        workingMemory: {
          enabled: true,
          scope: 'resource',
          template: '# Account context\n- Verified risks:\n- Approved actions:\n- Open questions:',
        },
        observationalMemory: config.observationalMemory
          ? { model: config.model, observation: { bufferOnIdle: true } }
          : false,
      },
    }),
  });
}
