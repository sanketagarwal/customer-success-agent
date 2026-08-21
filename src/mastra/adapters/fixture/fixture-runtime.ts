import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';

import { FixedClock } from '../../clock.js';
import { InMemoryOperationalStore } from '../../memory/operational-stores.js';
import { CustomerSuccessService } from '../../services/customer-success-service.js';
import { createAccountWorkflow } from '../../workflows/account-workflow.js';
import { createScheduledWorkflow } from '../../workflows/scheduled-workflow.js';
import { DeterministicCustomerSuccessIntelligence } from './deterministic-intelligence.js';
import { FixtureRepositories } from './fixture-repositories.js';
import { MockCrmWriter } from './mock-crm-writer.js';

const fixtureAsOf = '2026-08-17T09:00:00.000Z';

export async function createFixtureRuntime(
  options: {
    fixturePath?: string;
    asOf?: string;
    maxAccountConcurrency?: number;
  } = {},
) {
  const asOf = options.asOf ?? fixtureAsOf;
  const clock = new FixedClock(new Date(asOf));
  const fixtures = new FixtureRepositories(options.fixturePath ?? resolve('data/fixtures/accounts.json'));
  const store = new InMemoryOperationalStore();
  const writer = new MockCrmWriter(store, clock);
  const intelligence = new DeterministicCustomerSuccessIntelligence();
  const service = new CustomerSuccessService({
    usage: fixtures,
    support: fixtures,
    billing: fixtures,
    crm: fixtures,
    crmWriter: writer,
    memory: store,
    approvals: store,
    intelligence,
    monitoring: store,
    clock,
  });
  const accountWorkflow = createAccountWorkflow({
    service,
    operationalStore: store,
    config: { tenantId: 'demo-tenant' },
  });
  const scheduledWorkflow = createScheduledWorkflow(
    {
      crm: fixtures,
      config: {
        maxAccountConcurrency: options.maxAccountConcurrency ?? 4,
        cron: '0 9 * * 1',
        timezone: 'UTC',
        tenantId: 'demo-tenant',
      },
    },
    accountWorkflow,
  );
  const storageDirectory = await mkdtemp(join(tmpdir(), 'mastra-customer-success-'));
  const storage = new LibSQLStore({
    id: 'fixture-runtime-storage',
    url: `file:${join(storageDirectory, 'workflow.db')}`,
  });
  const mastra = new Mastra({
    storage,
    workflows: { accountWorkflow, scheduledWorkflow },
  });
  await mastra.getStorage()?.init();
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await mastra.getStorage()?.close();
    await storage.close();
    await rm(storageDirectory, { recursive: true, force: true });
  };
  return {
    asOf,
    clock,
    fixtures,
    store,
    writer,
    intelligence,
    service,
    accountWorkflow,
    scheduledWorkflow,
    storage,
    mastra,
    cleanup,
  };
}
