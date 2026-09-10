import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { createRenewalRiskAgent } from './agent.js';
import { loadConfig } from './config.js';
import { createDataSource } from './data.js';
import { ReviewHistory } from './history.js';
import {
  accountPlanQualityScorer,
  actionRelevanceScorer,
  personalizationScorer,
  riskFactorExtractionScorer,
  unsupportedClaimScorer,
} from './scorers.js';
import { createCustomerTools } from './tools.js';
import { createAccountWorkflow } from './workflows/account.js';
import { createScheduledWorkflow } from './workflows/scheduled.js';

const config = loadConfig();
const storage = new LibSQLStore({
  id: 'customer-success-storage',
  url: config.databaseUrl,
  ...(config.tursoAuthToken ? { authToken: config.tursoAuthToken } : {}),
});
const data = createDataSource(config);
const history = new ReviewHistory(config.databaseUrl, config.tursoAuthToken);
const tools = createCustomerTools(data, history);

export const renewalRiskAgent = createRenewalRiskAgent(config, storage, tools);
export const customerSuccessAgent = renewalRiskAgent;
export const renewalRiskWorkflow = createAccountWorkflow(
  data,
  history,
  renewalRiskAgent,
  config,
);
export const weeklyRenewalReviewWorkflow = createScheduledWorkflow(
  data,
  renewalRiskWorkflow,
  config,
);

// Preserve old API keys and suspended account runs without adding another schedule.
export const customerSuccessAccountWorkflow = createAccountWorkflow(
  data, history, renewalRiskAgent, config, 'customer-success-account',
);
export const weeklyCustomerSuccessWorkflow = createScheduledWorkflow(
  data, customerSuccessAccountWorkflow, config,
  { id: 'weekly-customer-success', scheduled: false },
);

export const mastra = new Mastra({
  storage,
  agents: { renewalRiskAgent, customerSuccessAgent },
  workflows: {
    renewalRiskWorkflow, weeklyRenewalReviewWorkflow,
    customerSuccessAccountWorkflow, weeklyCustomerSuccessWorkflow,
  },
  scorers: {
    riskFactorExtractionScorer,
    accountPlanQualityScorer,
    unsupportedClaimScorer,
    personalizationScorer,
    actionRelevanceScorer,
  },
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'customer-renewal-risk-and-recovery',
        exporters: [new MastraStorageExporter({ strategy: 'realtime' })],
        spanOutputProcessors: [
          new SensitiveDataFilter({
            sensitiveFields: ['authorization', 'token', 'body', 'feedback', 'email'],
          }),
        ],
        requestContextKeys: ['tenant-id', 'account-id'],
        logging: { enabled: false, level: 'info' },
      },
    },
  }),
});
