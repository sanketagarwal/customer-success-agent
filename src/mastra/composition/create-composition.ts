import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';

import { DeterministicCustomerSuccessIntelligence } from '../adapters/fixture/deterministic-intelligence.js';
import { FixtureRepositories } from '../adapters/fixture/fixture-repositories.js';
import { MockCrmWriter } from '../adapters/fixture/mock-crm-writer.js';
import { HubSpotAdapter } from '../adapters/hubspot/hubspot-adapter.js';
import { MastraCustomerSuccessIntelligence } from '../adapters/model/mastra-intelligence.js';
import { createCustomerSuccessAgent } from '../agents/customer-success-agent.js';
import { FixedClock } from '../clock.js';
import type { AppConfig } from '../config.js';
import { LibSqlOperationalStore } from '../memory/operational-stores.js';
import type {
  BillingRepository,
  Clock,
  CrmRepository,
  CrmWriter,
  CustomerSuccessIntelligence,
  SupportRepository,
  UsageRepository,
} from '../ports/index.js';
import { CustomerSuccessService } from '../services/customer-success-service.js';

export interface Composition {
  config: AppConfig;
  storage: LibSQLStore;
  agent: ReturnType<typeof createCustomerSuccessAgent>;
  service: CustomerSuccessService;
  crm: CrmRepository;
  clock: Clock;
  operationalStore: LibSqlOperationalStore;
}

export function createComposition(config: AppConfig): Composition {
  // Usage, support, and billing remain fixture-backed in both v1 modes, so the
  // operational clock stays pinned until those ports use live providers.
  const clock: Clock = new FixedClock(new Date(config.fixtureNow));
  const fixture = new FixtureRepositories(
    config.fixturePath,
    config.dataSource === 'hubspot' ? { sourceTenantId: config.fixtureTenantId } : {},
  );
  const operationalStore = new LibSqlOperationalStore(config.databaseUrl, config.tursoAuthToken);
  const storage = new LibSQLStore({
    id: 'customer-success-storage',
    url: config.databaseUrl,
    ...(config.tursoAuthToken ? { authToken: config.tursoAuthToken } : {}),
  });

  const vector = config.semanticRecall
    ? new LibSQLVector({ id: 'customer-success-vector', url: config.databaseUrl })
    : undefined;
  const embedder = config.semanticRecall
    ? new ModelRouterEmbeddingModel(config.embeddingModel)
    : undefined;
  const agent = createCustomerSuccessAgent({
    model: config.model,
    storage,
    ...(vector ? { vector } : {}),
    ...(embedder ? { embedder } : {}),
    observationalMemory: config.observationalMemory,
  });

  let crm: CrmRepository;
  let crmWriter: CrmWriter;
  if (config.dataSource === 'hubspot') {
    const hubspot = new HubSpotAdapter({
      tenantId: config.tenantId,
      token: config.hubspotToken!,
      baseUrl: config.hubspotBaseUrl,
      renewalProperty: config.hubspotRenewalProperty,
      clock,
      intents: operationalStore,
    });
    crm = hubspot;
    crmWriter = hubspot;
  } else {
    crm = fixture;
    crmWriter = new MockCrmWriter(operationalStore, clock);
  }

  const intelligence: CustomerSuccessIntelligence =
    config.generationMode === 'model'
      ? new MastraCustomerSuccessIntelligence(agent)
      : new DeterministicCustomerSuccessIntelligence();

  const usage: UsageRepository = fixture;
  const support: SupportRepository = fixture;
  const billing: BillingRepository = fixture;
  const service = new CustomerSuccessService({
    usage,
    support,
    billing,
    crm,
    crmWriter,
    memory: operationalStore,
    approvals: operationalStore,
    intelligence,
    clock,
  });

  return { config, storage, agent, service, crm, clock, operationalStore };
}
