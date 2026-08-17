import { resolve } from 'node:path';

import { DeterministicCustomerSuccessIntelligence } from '../src/mastra/adapters/fixture/deterministic-intelligence.js';
import { FixtureRepositories } from '../src/mastra/adapters/fixture/fixture-repositories.js';
import { MockCrmWriter } from '../src/mastra/adapters/fixture/mock-crm-writer.js';
import { FixedClock } from '../src/mastra/clock.js';
import { InMemoryOperationalStore } from '../src/mastra/memory/operational-stores.js';
import { CustomerSuccessService } from '../src/mastra/services/customer-success-service.js';

export const fixtureAsOf = '2026-08-17T09:00:00.000Z';

export function createTestSystem() {
  const clock = new FixedClock(new Date(fixtureAsOf));
  const fixtures = new FixtureRepositories(resolve('data/fixtures/accounts.json'));
  const store = new InMemoryOperationalStore();
  const writer = new MockCrmWriter(store, clock);
  const service = new CustomerSuccessService({
    usage: fixtures,
    support: fixtures,
    billing: fixtures,
    crm: fixtures,
    crmWriter: writer,
    memory: store,
    approvals: store,
    intelligence: new DeterministicCustomerSuccessIntelligence(),
    clock,
  });
  return { clock, fixtures, store, writer, service };
}
