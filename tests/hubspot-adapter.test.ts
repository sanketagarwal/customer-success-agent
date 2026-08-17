import { describe, expect, it, vi } from 'vitest';

import { HubSpotAdapter } from '../src/mastra/adapters/hubspot/hubspot-adapter.js';
import { FixedClock } from '../src/mastra/clock.js';
import { InMemoryOperationalStore } from '../src/mastra/memory/operational-stores.js';
import type { CrmWriteIntentStore } from '../src/mastra/ports/index.js';
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
    const intents = new InMemoryOperationalStore();
    const adapter = new HubSpotAdapter({
      tenantId: 'tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date('2026-08-17T09:00:00.000Z')),
      intents,
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
    const intents = new InMemoryOperationalStore();
    const adapter = new HubSpotAdapter({
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date(fixtureAsOf)),
      intents,
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

  it('rejects foreign-tenant reads and writes before any network call', async () => {
    const prepared = await createTestSystem().service.prepare({
      runId: 'hubspot-tenant-guard',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new HubSpotAdapter({
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date(fixtureAsOf)),
      intents: new InMemoryOperationalStore(),
      fetch: fetcher,
    });

    await expect(adapter.getCrmNotes({
      tenantId: 'foreign-tenant',
      accountId: prepared.accountId,
      window: { start: '2026-07-20T09:00:00.000Z', end: fixtureAsOf },
    })).rejects.toThrow('mismatched tenant');
    await expect(adapter.writeApprovedDraft({
      tenantId: 'foreign-tenant',
      accountId: prepared.accountId,
      runId: prepared.runId,
      idempotencyKey: 'foreign-write',
      assessment: prepared.assessment!,
      plan: prepared.plan!,
      outreach: prepared.outreach!,
    })).rejects.toThrow('mismatched tenant');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reconciles lost create responses and serializes concurrent replays', async () => {
    const prepared = await createTestSystem().service.prepare({
      runId: 'hubspot-ambiguous-write',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    const idempotencyKey = 'ambiguous-write';
    const marker = `[customer-success-idempotency:${idempotencyKey}]`;
    const action = prepared.plan!.actions[0]!;
    const taskMarker = `${marker}[action:${action.id}]`;
    let taskCommitted = false;
    let noteCommitted = false;
    let taskCreates = 0;
    let noteCreates = 0;
    const object = (id: string, properties: Record<string, string>) => ({
      id,
      createdAt: fixtureAsOf,
      updatedAt: fixtureAsOf,
      properties,
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/associations/2026-03/tasks/companies/labels')) {
        return jsonResponse({
          results: [{ typeId: 192, category: 'HUBSPOT_DEFINED', label: null }],
        });
      }
      if (url.includes('/objects/companies/') && url.includes('associations=tasks')) {
        return jsonResponse({
          ...object('company-declining', {}),
          associations: { tasks: { results: taskCommitted ? [{ id: 'task-1' }] : [] } },
        });
      }
      if (url.includes('/objects/tasks/batch/read')) {
        return jsonResponse({ results: [object('task-1', { hs_task_body: taskMarker })] });
      }
      if (url.includes('/objects/companies/') && url.includes('associations=notes')) {
        return jsonResponse({
          ...object('company-declining', {}),
          associations: { notes: { results: noteCommitted ? [{ id: 'note-1' }] : [] } },
        });
      }
      if (url.includes('/objects/notes/batch/read')) {
        return jsonResponse({
          results: [object('note-1', { hs_note_body: marker, hs_timestamp: fixtureAsOf })],
        });
      }
      if (init?.method === 'POST' && url.endsWith('/tasks')) {
        taskCreates += 1;
        taskCommitted = true;
        throw new TypeError('response lost after task commit');
      }
      if (init?.method === 'POST' && url.endsWith('/notes')) {
        noteCreates += 1;
        noteCommitted = true;
        throw new TypeError('response lost after note commit');
      }
      throw new Error(`Unexpected HubSpot request: ${url}`);
    });
    const intents = new InMemoryOperationalStore();
    const adapter = new HubSpotAdapter({
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date(fixtureAsOf)),
      intents,
      fetch: fetcher,
    });
    const input = {
      tenantId: prepared.tenantId,
      accountId: prepared.accountId,
      runId: prepared.runId,
      idempotencyKey,
      assessment: prepared.assessment!,
      plan: { ...prepared.plan!, actions: [action] },
      outreach: prepared.outreach!,
    };

    const [first, concurrent] = await Promise.all([
      adapter.writeApprovedDraft(input),
      adapter.writeApprovedDraft(input),
    ]);
    expect(first).toMatchObject({ writeId: 'note-1', created: true });
    expect(concurrent).toEqual(first);
    expect(taskCreates).toBe(1);
    expect(noteCreates).toBe(1);

    const replay = await adapter.writeApprovedDraft(input);
    expect(replay).toMatchObject({ writeId: 'note-1', created: false });
    expect(taskCreates).toBe(1);
    expect(noteCreates).toBe(1);
  });

  it('fails closed instead of replaying an ambiguous create before its marker is visible', async () => {
    const intents = new InMemoryOperationalStore();
    const prepared = await createTestSystem().service.prepare({
      runId: 'hubspot-invisible-commit',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    let taskCreates = 0;
    let failReconciliationRead = true;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/associations/2026-03/tasks/companies/labels')) {
        return jsonResponse({
          results: [{ typeId: 192, category: 'HUBSPOT_DEFINED', label: null }],
        });
      }
      if (url.includes('/objects/companies/') && url.includes('associations=tasks')) {
        if (taskCreates > 0 && failReconciliationRead) {
          return jsonResponse({ message: 'temporary reconciliation denial' }, 401);
        }
        return jsonResponse({
          id: 'company-declining',
          createdAt: fixtureAsOf,
          updatedAt: fixtureAsOf,
          properties: {},
          associations: { tasks: { results: [] } },
        });
      }
      if (init?.method === 'POST' && url.endsWith('/tasks')) {
        taskCreates += 1;
        throw new TypeError('response lost after an unobservable commit');
      }
      throw new Error(`Unexpected HubSpot request: ${url}`);
    });
    const adapter = new HubSpotAdapter({
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date(fixtureAsOf)),
      intents,
      fetch: fetcher,
    });
    const input = {
      tenantId: prepared.tenantId,
      accountId: prepared.accountId,
      runId: prepared.runId,
      idempotencyKey: 'invisible-commit',
      assessment: prepared.assessment!,
      plan: { ...prepared.plan!, actions: [prepared.plan!.actions[0]!] },
      outreach: prepared.outreach!,
    };

    await expect(adapter.writeApprovedDraft(input)).rejects.toThrow('HubSpot 401');
    failReconciliationRead = false;
    const restartedAdapter = new HubSpotAdapter({
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date(fixtureAsOf)),
      intents,
      fetch: fetcher,
    });
    await expect(restartedAdapter.writeApprovedDraft(input)).rejects.toThrow(
      'durable task write intent is pending',
    );
    expect(taskCreates).toBe(1);
  });

  it('preserves a durable pending intent when local completion fails after a successful create', async () => {
    const durable = new InMemoryOperationalStore();
    let failCompletion = true;
    const intents: CrmWriteIntentStore = {
      claim: (key, attemptedAt) => durable.claim(key, attemptedAt),
      getIntent: (key) => durable.getIntent(key),
      async completeIntent(key, writeId, completedAt) {
        if (failCompletion) {
          failCompletion = false;
          throw new Error('simulated local intent completion failure');
        }
        await durable.completeIntent(key, writeId, completedAt);
      },
      releaseIntent: (key) => durable.releaseIntent(key),
    };
    const prepared = await createTestSystem().service.prepare({
      runId: 'hubspot-local-completion-failure',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    let taskCreates = 0;
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
      if (init?.method === 'POST' && url.endsWith('/tasks')) {
        taskCreates += 1;
        return jsonResponse({
          id: 'created-task',
          createdAt: fixtureAsOf,
          updatedAt: fixtureAsOf,
          properties: {},
        }, 201);
      }
      throw new Error(`Unexpected HubSpot request: ${url}`);
    });
    const options = {
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      clock: new FixedClock(new Date(fixtureAsOf)),
      intents,
      fetch: fetcher,
    };
    const input = {
      tenantId: prepared.tenantId,
      accountId: prepared.accountId,
      runId: prepared.runId,
      idempotencyKey: 'local-completion-failure',
      assessment: prepared.assessment!,
      plan: { ...prepared.plan!, actions: [prepared.plan!.actions[0]!] },
      outreach: prepared.outreach!,
    };

    await expect(new HubSpotAdapter(options).writeApprovedDraft(input)).rejects.toThrow(
      'simulated local intent completion failure',
    );
    await expect(new HubSpotAdapter(options).writeApprovedDraft(input)).rejects.toThrow(
      'durable task write intent is pending',
    );
    expect(taskCreates).toBe(1);
  });
});
