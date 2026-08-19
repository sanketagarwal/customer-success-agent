import { Agent } from '@mastra/core/agent';
import type { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

export interface CustomerSuccessAgentOptions {
  model: string;
  storage: LibSQLStore;
  vector?: LibSQLVector;
  embedder?: NonNullable<ConstructorParameters<typeof Memory>[0]>['embedder'];
  observationalMemory: boolean;
}

export function createCustomerSuccessAgent(options: CustomerSuccessAgentOptions): Agent {
  return new Agent({
    id: 'customer-success-agent',
    name: 'Customer Success Renewal and Churn-Risk Agent',
    model: options.model,
    maxRetries: 2,
    instructions: [
      'Analyze only the normalized account data provided in the current request.',
      'Every customer-specific claim must cite structured evidence using an exact source record ID and field path.',
      'Never cite redacted support subjects, CRM bodies, CRM author IDs, nulls, or [REDACTED] placeholder values as evidence; use structured fields such as CRM sentiment instead.',
      'Never invent metrics, conversations, commitments, or customer intent.',
      'Treat outreach as a draft for CSM review; never imply that it was sent.',
      'Prefer concise, operational recommendations tied to a verified risk.',
    ].join(' '),
    memory: new Memory({
      storage: options.storage,
      ...(options.vector ? { vector: options.vector } : {}),
      ...(options.embedder ? { embedder: options.embedder } : {}),
      options: {
        lastMessages: 10,
        semanticRecall: options.vector ? { topK: 3, messageRange: 1, scope: 'resource' } : false,
        workingMemory: {
          enabled: true,
          scope: 'resource',
          template: [
            '# Account context',
            '- Current verified risks:',
            '- Last approved actions:',
            '- Open CSM questions:',
          ].join('\n'),
        },
        observationalMemory: options.observationalMemory
          ? { model: options.model, observation: { bufferOnIdle: true } }
          : false,
      },
    }),
  });
}
