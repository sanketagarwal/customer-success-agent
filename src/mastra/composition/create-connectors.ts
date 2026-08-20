import { FixtureRepositories } from '../adapters/fixture/fixture-repositories.js';
import { MockCrmWriter } from '../adapters/fixture/mock-crm-writer.js';
import { HubSpotAdapter } from '../adapters/hubspot/hubspot-adapter.js';
import { FixedClock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { LibSqlOperationalStore } from '../memory/operational-stores.js';
import type {
  BillingRepository,
  Clock,
  CrmRepository,
  CrmWriter,
  SupportRepository,
  UsageRepository,
} from '../ports/index.js';

export interface CustomerSuccessConnectors {
  usage: UsageRepository;
  support: SupportRepository;
  billing: BillingRepository;
  crm: CrmRepository;
  crmWriter: CrmWriter;
  clock: Clock;
}

export type ConnectorOverrides = Partial<CustomerSuccessConnectors>;

/**
 * The single connector boundary for this template.
 *
 * Fixtures make the cloned project runnable immediately. HubSpot is included as
 * one example CRM implementation. Replace any returned port—or pass an override
 * from your own composition—to connect the systems your company uses.
 */
export function createConnectors(
  config: AppConfig,
  operationalStore: LibSqlOperationalStore,
  overrides: ConnectorOverrides = {},
): CustomerSuccessConnectors {
  const clock = overrides.clock ?? new FixedClock(new Date(config.fixtureNow));
  const fixture = new FixtureRepositories(
    config.fixturePath,
    config.crmProvider === 'hubspot' ? { sourceTenantId: config.fixtureTenantId } : {},
  );

  let crm: CrmRepository = fixture;
  let crmWriter: CrmWriter = new MockCrmWriter(operationalStore, clock);

  if (config.crmProvider === 'hubspot') {
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
  }

  return {
    usage: overrides.usage ?? fixture,
    support: overrides.support ?? fixture,
    billing: overrides.billing ?? fixture,
    crm: overrides.crm ?? crm,
    crmWriter: overrides.crmWriter ?? crmWriter,
    clock,
  };
}
