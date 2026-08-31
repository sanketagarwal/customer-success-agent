import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { createCustomerSuccessAgent } from './agent.js';
import { loadConfig } from './config.js';
import { createDataSource } from './data.js';
import { ReviewHistory } from './history.js';
import { accountPlanQualityScorer, actionRelevanceScorer, personalizationScorer, riskFactorExtractionScorer, unsupportedClaimScorer } from './scorers.js';
import { createCustomerTools } from './tools.js';
import { createAccountWorkflow } from './workflows/account.js';
import { createScheduledWorkflow } from './workflows/scheduled.js';
const config = loadConfig();
const storage = new LibSQLStore({ id: 'customer-success-storage', url: config.databaseUrl, ...(config.tursoAuthToken ? { authToken: config.tursoAuthToken } : {}) });
const data = createDataSource(config);
const history = new ReviewHistory(config.databaseUrl, config.tursoAuthToken);
const tools = createCustomerTools(data, history);
export const customerSuccessAgent = createCustomerSuccessAgent(config, storage, tools);
export const customerSuccessAccountWorkflow = createAccountWorkflow(data, history, customerSuccessAgent, config);
export const weeklyCustomerSuccessWorkflow = createScheduledWorkflow(
  data,
  customerSuccessAccountWorkflow,
  config,
);
export const mastra = new Mastra({
  storage,
  agents: { customerSuccessAgent },
  workflows: { customerSuccessAccountWorkflow, weeklyCustomerSuccessWorkflow },
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
        serviceName: 'customer-success-agent',
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
