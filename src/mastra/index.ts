import { Mastra } from '@mastra/core/mastra';
import type { ToolAction } from '@mastra/core/tools';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';

import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';
import {
  accountPlanQualityScorer,
  actionRelevanceScorer,
  personalizationScorer,
  riskFactorExtractionScorer,
  unsupportedClaimScorer,
} from './scorers.js';

export const runtime = createRuntime(loadConfig());
export const customerSuccessAccountWorkflow = runtime.accountWorkflow;
export const weeklyCustomerSuccessWorkflow = runtime.scheduledWorkflow;

export const mastra = new Mastra({
  storage: runtime.storage,
  agents: { customerSuccessAgent: runtime.agent },
  workflows: {
    customerSuccessAccountWorkflow,
    weeklyCustomerSuccessWorkflow,
  },
  // createTool types execute as optional; every registered tool above supplies it.
  tools: runtime.tools as unknown as Record<string, ToolAction<any, any>>,
  scorers: {
    unsupportedClaimScorer,
    riskFactorExtractionScorer,
    accountPlanQualityScorer,
    personalizationScorer,
    actionRelevanceScorer,
  },
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'customer-success-agent',
        exporters: [new MastraStorageExporter({ strategy: 'realtime' })],
        spanOutputProcessors: [new SensitiveDataFilter({
          sensitiveFields: ['authorization', 'token', 'body', 'feedback', 'notes', 'email'],
        })],
        requestContextKeys: ['tenant-id', 'account-id'],
        logging: { enabled: false, level: 'info' },
      },
    },
  }),
});
