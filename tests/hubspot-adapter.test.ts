import { describe, expect, it, vi } from 'vitest';

import { HubSpotAdapter } from '../src/mastra/adapters/hubspot/hubspot-adapter.js';
import { FixedClock } from '../src/mastra/clock.js';
import { createTestSystem, fixtureAsOf } from './helpers.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HubSpot adapter', () => {
  it('maps HubSpot company IDs to provider-neutral account IDs with pagination', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              id: '12345',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
              properties: {
                name: 'Example Company',
                hubspot_owner_id: '77',
                renewal_date: '2026-10-01T00:00:00.000Z',
              },
            },
          ],
        }),
      );
    const adapter = new HubSpotAdapter({
      tenantId: 'tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date('2026-08-17T09:00:00.000Z')),
      fetch: fetcher,
    });
    await expect(adapter.listAccounts('tenant')).resolves.toEqual([
      {
        tenantId: 'tenant',
        accountId: '12345',
        name: 'Example Company',
        renewalAt: '2026-10-01T00:00:00.000Z',
        ownerId: '77',
      },
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
  });

  it('writes internal notes and follow-up tasks without calling an email API', async () => {
    const prepared = await createTestSystem().service.prepare({
      runId: 'hubspot-write',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    let createdObject = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/associations/2026-03/tasks/companies/labels')) {
        return jsonResponse({
          results: [{ typeId: 192, category: 'HUBSPOT_DEFINED', label: null }],
        });
      }
      if (url.includes('/objects/companies/') && url.includes('associations=tasks')) {
        return jsonResponse({
          id: 'company-declining',
          createdAt: fixtureAsOf,
          updatedAt: fixtureAsOf,
          properties: {},
          associations: { tasks: { results: [] } },
        });
      }
      if (url.includes('/objects/companies/') && url.includes('associations=notes')) {
        return jsonResponse({
          id: 'company-declining',
          createdAt: fixtureAsOf,
          updatedAt: fixtureAsOf,
          properties: {},
          associations: { notes: { results: [] } },
        });
      }
      if (init?.method === 'POST' && (url.endsWith('/tasks') || url.endsWith('/notes'))) {
        createdObject += 1;
        return jsonResponse({
          id: `created-${createdObject}`,
          createdAt: fixtureAsOf,
          updatedAt: fixtureAsOf,
          properties: {},
        }, 201);
      }
      throw new Error(`Unexpected HubSpot request: ${url}`);
    });
    const adapter = new HubSpotAdapter({
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date(fixtureAsOf)),
      fetch: fetcher,
    });
    const result = await adapter.writeApprovedDraft({
      tenantId: prepared.tenantId,
      accountId: prepared.accountId,
      runId: prepared.runId,
      idempotencyKey: 'idempotency-test',
      assessment: prepared.assessment!,
      plan: prepared.plan!,
      outreach: prepared.outreach!,
    });
    expect(result).toMatchObject({ created: true, idempotencyKey: 'idempotency-test' });
    const urls = fetcher.mock.calls.map(([input]) => String(input));
    expect(urls.filter((url) => url.endsWith('/tasks'))).toHaveLength(prepared.plan!.actions.length);
    expect(urls.some((url) => url.endsWith('/notes'))).toBe(true);
    expect(urls.some((url) => url.includes('email'))).toBe(false);
  });
});
