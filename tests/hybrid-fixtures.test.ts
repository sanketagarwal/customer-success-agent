import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FixtureRepositories } from '../src/mastra/adapters/fixture/fixture-repositories.js';
import { createComposition } from '../src/mastra/composition/create-composition.js';
import { loadConfig } from '../src/mastra/config.js';
import { fixtureAsOf } from './helpers.js';

describe('HubSpot and fixture hybrid mode', () => {
  it('maps the configured fixture tenant to the runtime tenant without changing account scope', async () => {
    const fixtures = new FixtureRepositories(resolve('data/fixtures/accounts.json'), {
      sourceTenantId: 'demo-tenant',
    });
    const result = await fixtures.getUsage({
      tenantId: 'customer-tenant',
      accountId: '340739743463',
      window: { start: '2026-07-20T09:00:00.000Z', end: fixtureAsOf },
    });

    expect(result).toMatchObject({
      status: 'available',
      data: { tenantId: 'customer-tenant', accountId: '340739743463' },
    });
    await expect(fixtures.getUsage({
      tenantId: 'customer-tenant',
      accountId: 'not-a-fixture-account',
      window: { start: '2026-07-20T09:00:00.000Z', end: fixtureAsOf },
    })).resolves.toEqual({ status: 'empty' });
  });

  it('keeps the hybrid composition clock pinned to fixture time', () => {
    const config = loadConfig({
      DATA_SOURCE: 'hubspot',
      TENANT_ID: 'customer-tenant',
      FIXTURE_TENANT_ID: 'demo-tenant',
      FIXTURE_NOW: fixtureAsOf,
      FIXTURE_PATH: './data/fixtures/accounts.json',
      MASTRA_DB_URL: 'file::memory:',
      HUBSPOT_PRIVATE_APP_TOKEN: 'test-token',
      PWD: process.cwd(),
    });
    const composition = createComposition(config);

    expect(composition.clock.now().toISOString()).toBe(fixtureAsOf);
  });
});
