import { Mastra } from '@mastra/core/mastra';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';

import { createComposition } from './composition/create-composition.js';
import { loadConfig } from './config.js';
import {
  accountPlanQualityScorer,
  actionRelevanceScorer,
  groundednessScorer,
  personalizationScorer,
  riskFactorExtractionScorer,
} from './scorers/index.js';
import { createAccountWorkflow } from './workflows/account-workflow.js';
import { createScheduledWorkflow } from './workflows/scheduled-workflow.js';

export const composition = createComposition(loadConfig());
export const customerSuccessAccountWorkflow = createAccountWorkflow(composition);
export const weeklyCustomerSuccessWorkflow = createScheduledWorkflow(
  composition,
  customerSuccessAccountWorkflow,
);

export const mastra = new Mastra({
  storage: composition.storage,
  agents: { customerSuccessAgent: composition.agent },
  workflows: { customerSuccessAccountWorkflow, weeklyCustomerSuccessWorkflow },
  scorers: {
    groundednessScorer,
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
        spanOutputProcessors: [
          new SensitiveDataFilter({
            sensitiveFields: [
              'authorization',
              'token',
              'body',
              'subject',
              'feedback',
              'notes',
              'crmNotes',
              'email',
            ],
          }),
        ],
        requestContextKeys: ['tenant-id', 'account-id'],
        logging: { enabled: false, level: 'info' },
      },
    },
  }),
});
