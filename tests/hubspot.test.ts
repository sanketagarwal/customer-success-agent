import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FixtureConnector } from '../src/mastra/connectors.js';
import { prepareReview } from '../src/mastra/customer-success.js';
import { HubSpotConnector } from '../src/mastra/hubspot.js';
import { FixtureReviewer } from '../src/mastra/reviewer.js';
import { MemoryState } from '../src/mastra/state.js';
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
    let hideTasks = false;
    let loseTaskResponse = false;
    let taskDelayMs = 0;
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
        return json({ results: hideTasks ? [] : tasks.map(task => ({ toObjectId: task.id })) });
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
        if (taskDelayMs) await new Promise(resolveDelay => setTimeout(resolveDelay, taskDelayMs));
        const task = { id: `task-${tasks.length + 1}`, createdAt: '2026-08-17T09:00:00.000Z', properties: body.properties };
        tasks.push(task);
        if (loseTaskResponse) {
          loseTaskResponse = false;
          throw new Error('connection lost after commit');
        }
        return json(task, 201);
      }
      if (url.pathname === '/crm/v3/objects/notes' && init?.method === 'POST') {
        const note = { id: `note-${notes.length + 1}`, createdAt: '2026-08-17T09:00:00.000Z', properties: body.properties };
        notes.push(note);
        return json(note, 201);
      }
      return json({ message: `Unhandled ${url.pathname}` }, 404);
    });
    const options = {
      tenantId: 'demo-tenant',
      token: 'test-token',
      baseUrl: 'https://api.hubapi.com',
      renewalProperty: 'renewal_date',
      writes: new MemoryState(),
      fetch: fetcher as typeof fetch,
    };
    const hubspot = new HubSpotConnector(options);

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
    const second = await new HubSpotConnector(options).writeToCrm(input);
    expect(first).toMatchObject({ created: true });
    expect(second).toEqual({ ...first, created: false });
    expect(tasks).toHaveLength(review.plan.actions.length);
    expect(notes).toHaveLength(2);

    await hubspot.writeToCrm({ ...input, runId: 'another-run' });
    expect(tasks).toHaveLength(review.plan.actions.length * 2);

    loseTaskResponse = true;
    await expect(hubspot.writeToCrm({ ...input, runId: 'lost-response' })).resolves.toMatchObject({ created: true });
    expect(tasks).toHaveLength(review.plan.actions.length * 3);

    hideTasks = true;
    loseTaskResponse = true;
    await expect(hubspot.writeToCrm({ ...input, runId: 'delayed-association' })).rejects.toThrow();
    const countAfterAmbiguousCommit = tasks.length;
    hideTasks = false;
    await expect(hubspot.writeToCrm({ ...input, runId: 'delayed-association' })).resolves.toMatchObject({ created: true });
    expect(tasks).toHaveLength(countAfterAmbiguousCommit);

    taskDelayMs = 20;
    const concurrentInput = { ...input, runId: 'concurrent-run' };
    const concurrent = await Promise.allSettled([
      hubspot.writeToCrm(concurrentInput),
      new HubSpotConnector(options).writeToCrm(concurrentInput),
    ]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(tasks).toHaveLength(countAfterAmbiguousCommit + review.plan.actions.length);
  });
});
