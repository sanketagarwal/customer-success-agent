import { resolve } from 'node:path';

import { DeterministicCustomerSuccessIntelligence } from '../src/mastra/adapters/fixture/deterministic-intelligence.js';
import { FixtureRepositories } from '../src/mastra/adapters/fixture/fixture-repositories.js';
import { MockCrmWriter } from '../src/mastra/adapters/fixture/mock-crm-writer.js';
import { FixedClock } from '../src/mastra/clock.js';
import { InMemoryOperationalStore } from '../src/mastra/memory/operational-stores.js';
import { CustomerSuccessService } from '../src/mastra/services/customer-success-service.js';

const asOf = '2026-08-17T09:00:00.000Z';
const clock = new FixedClock(new Date(asOf));
const fixtures = new FixtureRepositories(resolve('data/fixtures/accounts.json'));
const store = new InMemoryOperationalStore();
const service = new CustomerSuccessService({
  usage: fixtures,
  support: fixtures,
  billing: fixtures,
  crm: fixtures,
  crmWriter: new MockCrmWriter(store, clock),
  memory: store,
  approvals: store,
  intelligence: new DeterministicCustomerSuccessIntelligence(),
  clock,
});

const accounts = await fixtures.listAccounts('demo-tenant');
const results = await Promise.all(
  accounts.map((account) =>
    service.prepare({
      runId: `demo-${account.accountId}`,
      tenantId: account.tenantId,
      accountId: account.accountId,
      asOf,
    }),
  ),
);

console.log(
  JSON.stringify(
    results.map(({ accountId, outcome, assessment, drift, message }) => ({
      accountId,
      outcome,
      score: assessment?.score ?? null,
      drift: drift?.direction ?? null,
      message,
    })),
    null,
    2,
  ),
);
