import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';

import { DeterministicCustomerSuccessIntelligence } from '../adapters/fixture/deterministic-intelligence.js';
import { MastraCustomerSuccessIntelligence } from '../adapters/model/mastra-intelligence.js';
import { createCustomerSuccessAgent } from '../agents/customer-success-agent.js';
import type { AppConfig } from '../config.js';
import { LibSqlOperationalStore } from '../memory/operational-stores.js';
import type { Clock, CrmRepository, CrmWriter, CustomerSuccessIntelligence } from '../ports/index.js';
import { CustomerSuccessService } from '../services/customer-success-service.js';
import { createCrmTools, type CustomerSuccessCrmTools } from '../tools/crm-tools.js';
import { createConnectors, type ConnectorOverrides } from './create-connectors.js';

export interface Composition {
  config: AppConfig;
  storage: LibSQLStore;
  agent: ReturnType<typeof createCustomerSuccessAgent>;
  service: CustomerSuccessService;
  crm: CrmRepository;
  crmWriter: CrmWriter;
  crmTools: CustomerSuccessCrmTools;
  clock: Clock;
  operationalStore: LibSqlOperationalStore;
}

export function libSqlConnectionOptions(url: string, authToken?: string) {
  return { url, ...(authToken ? { authToken } : {}) };
}

export function createComposition(config: AppConfig, connectorOverrides: ConnectorOverrides = {}): Composition {
  const operationalStore = new LibSqlOperationalStore(config.databaseUrl, config.tursoAuthToken);
  const storage = new LibSQLStore({
    id: 'customer-success-storage',
    ...libSqlConnectionOptions(config.databaseUrl, config.tursoAuthToken),
  });

  const vector = config.semanticRecall
    ? new LibSQLVector({
        id: 'customer-success-vector',
        ...libSqlConnectionOptions(config.databaseUrl, config.tursoAuthToken),
      })
    : undefined;
  const embedder = config.semanticRecall ? new ModelRouterEmbeddingModel(config.embeddingModel) : undefined;
  const agent = createCustomerSuccessAgent({
    model: config.model,
    storage,
    ...(vector ? { vector } : {}),
    ...(embedder ? { embedder } : {}),
    observationalMemory: config.observationalMemory,
  });

  const { usage, support, billing, crm, crmWriter, clock } = createConnectors(
    config,
    operationalStore,
    connectorOverrides,
  );

  const intelligence: CustomerSuccessIntelligence =
    config.generationMode === 'model'
      ? new MastraCustomerSuccessIntelligence(agent, {
          inputCostPerMillion: config.modelInputCostPerMillion,
          outputCostPerMillion: config.modelOutputCostPerMillion,
        })
      : new DeterministicCustomerSuccessIntelligence();

  const service = new CustomerSuccessService({
    usage,
    support,
    billing,
    crm,
    crmWriter,
    memory: operationalStore,
    approvals: operationalStore,
    intelligence,
    monitoring: operationalStore,
    clock,
  });
  const crmTools = createCrmTools(crm, crmWriter);

  return { config, storage, agent, service, crm, crmWriter, crmTools, clock, operationalStore };
}
