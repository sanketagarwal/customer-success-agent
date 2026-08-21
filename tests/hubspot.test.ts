import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FixtureConnector } from '../src/mastra/connectors.js';
import { prepareReview } from '../src/mastra/customer-success.js';
import { HubSpotConnector } from '../src/mastra/hubspot.js';
import { FixtureReviewer } from '../src/mastra/reviewer.js';
import { collectAccountData } from '../src/mastra/workflows.js';

const json = (value: unknown, status = 200) => Response.json(value, { status });

describe('HubSpot connector', () => {
  it('lists companies, reads notes, and idempotently creates a note and follow-up tasks', async () => {
    const notes = [{
      id: 'note-existing',
      createdAt: '2026-08-10T09:00:00.000Z',
      properties: {
        hs_timestamp: '2026-08-10T09:00:00.000Z',
        hs_note_body: 'Existing account note',
        hubspot_owner_id: 'owner-1',
      },
    }];
    const tasks: Array<{ id: string; createdAt: string; properties: Record<string, string> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === '/crm/v3/objects/companies') return json({
        results: [{
          id: '340734348989',
          createdAt: '2026-01-01T00:00:00.000Z',
          properties: { name: 'Redwood Retail', hubspot_owner_id: 'owner-1', renewal_date: '2026-09-12' },
        }],
      });
      if (url.pathname.endsWith('/associations/notes')) {
        return json({ results: notes.map(note => ({ toObjectId: note.id })) });
      }
      if (url.pathname.endsWith('/associations/tasks')) {
        return json({ results: tasks.map(task => ({ toObjectId: task.id })) });
      }
      if (url.pathname === '/crm/v3/objects/notes/batch/read') {
        return json({ results: notes.filter(note => body.inputs.some((item: { id: string }) => item.id === note.id)) });
      }
      if (url.pathname === '/crm/v3/objects/tasks/batch/read') {
        return json({ results: tasks.filter(task => body.inputs.some((item: { id: string }) => item.id === task.id)) });
      }
      if (url.pathname === '/crm/associations/2026-03/tasks/companies/labels') {
        return json({ results: [{ typeId: 192, category: 'HUBSPOT_DEFINED', label: null }] });
      }
      if (url.pathname === '/crm/v3/objects/tasks' && init?.method === 'POST') {
        const task = { id: `task-${tasks.length + 1}`, createdAt: '2026-08-17T09:00:00.000Z', properties: body.properties };
        tasks.push(task);
        return json(task, 201);
      }
      if (url.pathname === '/crm/v3/objects/notes' && init?.method === 'POST') {
        const note = { id: `note-${notes.length + 1}`, createdAt: '2026-08-17T09:00:00.000Z', properties: body.properties };
        notes.push(note);
        return json(note, 201);
      }
      return json({ message: `Unhandled ${url.pathname}` }, 404);
    });
    const hubspot = new HubSpotConnector({
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      renewalProperty: 'renewal_date',
      fetch: fetcher as typeof fetch,
    });

    await expect(hubspot.listAccounts('demo-tenant')).resolves.toMatchObject([
      { accountId: '340734348989', name: 'Redwood Retail', renewalAt: '2026-09-12T00:00:00.000Z' },
    ]);
    await expect(hubspot.readCrmNotes({
      tenantId: 'demo-tenant',
      accountId: '340734348989',
      window: { start: '2026-07-20T09:00:00.000Z', end: '2026-08-17T09:00:00.000Z' },
    })).resolves.toMatchObject({ status: 'available', data: { notes: [{ recordId: 'note-existing' }] } });

    const fixtures = new FixtureConnector(resolve('data/fixtures/accounts.json'));
    const snapshot = await collectAccountData(
      fixtures,
      'demo-tenant',
      '340734348989',
      { start: '2026-07-20T09:00:00.000Z', end: '2026-08-17T09:00:00.000Z' },
    );
    const { review } = await prepareReview(snapshot, new FixtureReviewer(), null);
    const input = { tenantId: 'demo-tenant', accountId: '340734348989', runId: 'hubspot-demo', review };
    const first = await hubspot.writeToCrm(input);
    const second = await hubspot.writeToCrm(input);
    expect(first).toMatchObject({ created: true });
    expect(second).toEqual({ ...first, created: false });
    expect(tasks).toHaveLength(review.plan.actions.length);
    expect(notes).toHaveLength(2);
  });
});
