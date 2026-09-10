import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import type { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { createClient, type Client } from '@libsql/client';
import { loadConfig } from '../src/mastra/config.js';
import { createDataSource, FixtureDataSource, type CustomerDataSource } from '../src/mastra/data.js';
import { ReviewHistory } from '../src/mastra/history.js';
import { persistApprovedReview } from '../src/mastra/approval.js';
import { WriteNotAppliedError } from '../src/mastra/writes.js';
import { assess, createAccountWorkflow } from '../src/mastra/workflows/account.js';
import { createScheduledWorkflow } from '../src/mastra/workflows/scheduled.js';

const fixturePath = resolve('data/fixtures/accounts.json');
const fixtures = new FixtureDataSource(fixturePath);
const config = loadConfig({ FIXTURE_PATH: fixturePath, CUSTOMER_SUCCESS_CRON: '0 0 1 1 *' });
const agent = { generate: () => { throw new Error('Unexpected model request'); } } as unknown as Agent;

test('unknown data is not healthy; low adoption does not require a baseline', async () => {
  const account = (await fixtures.getAccount('340739743463'))!;
  const missing = assess({ ...account, usage: { previousAdoption: null, currentAdoption: null },
    support: { urgentOpenTickets: null }, billing: { standing: 'unknown', daysPastDue: null },
    crm: { sentiment: 'unknown' }, unavailable: [] }, 'missing');
  assert.equal(missing.outcome, 'insufficient_data');
  assert.equal(missing.score, null);
  const low = assess({ ...account, usage: { previousAdoption: null, currentAdoption: 0.1 } }, 'low');
  assert.equal(low.risks.find(risk => risk.category === 'usage')?.title, 'Product adoption is low');
});

test('usage-signal requests have a bounded timeout', async (t) => {
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 30_000);
    return AbortSignal.abort(new DOMException('Signals timed out', 'TimeoutError'));
  });
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    assert.ok(init?.signal?.aborted);
    throw init.signal.reason;
  });
  const source = createDataSource(loadConfig({ FIXTURE_PATH: fixturePath, SIGNALS_API_URL: 'https://example.invalid' }));
  await assert.rejects(source.getAccount('340734348989'), { name: 'TimeoutError' });
  assert.equal(fetch.mock.callCount(), 1);
});

test('concurrent claims cannot repeat a completed external write', async () => {
  const history = new ReviewHistory(':memory:');
  try {
    await history.record(assess((await fixtures.getAccount('340734348989'))!, 'race'));
    const client = Reflect.get(history, 'client') as Client;
    const execute = client.execute.bind(client);
    let selected!: () => void, release!: () => void, finish!: () => void;
    const selectedGate = new Promise<void>(r => { selected = r; });
    const releaseGate = new Promise<void>(r => { release = r; });
    const finishGate = new Promise<void>(r => { finish = r; });
    let reads = 0, writes = 0, started!: () => void;
    const startedGate = new Promise<void>(r => { started = r; });
    client.execute = async statement => {
      const result = await execute(statement);
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (sql.startsWith('SELECT write_result') && ++reads === 2) {
        selected();
        await releaseGate;
      }
      return result;
    };
    const first = history.writeOnce('race', async () => {
      writes++; started(); await finishGate; return { writeId: 'one' };
    });
    await startedGate;
    const second = history.writeOnce('race', async () => { writes++; return { writeId: 'two' }; });
    const secondSettled = second.catch(error => error as Error);
    await selectedGate;
    finish();
    assert.deepEqual(await first, { writeId: 'one' });
    release();
    await secondSettled;
    assert.equal(writes, 1);
    assert.deepEqual(await history.writeOnce('race', async () => { throw Error('Must not write'); }), { writeId: 'one' });
  } finally { history.close(); }
});

test('partial CRM failures retain successful tasks; uncertain results do not auto-retry', async () => {
  const history = new ReviewHistory(':memory:');
  const review = assess((await fixtures.getAccount('340734348989'))!, 'partial');
  const source = createDataSource(loadConfig({ DATA_SOURCE: 'hubspot', HUBSPOT_PRIVATE_APP_TOKEN: 'mock', HUBSPOT_BASE_URL: 'https://example.invalid' }));
  const originalFetch = globalThis.fetch;
  const taskCalls: string[] = [];
  let rejectTask = true;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/tasks')) {
      const body = JSON.parse(String(init?.body)) as { properties: { hs_task_subject: string } };
      const title = body.properties.hs_task_subject;
      taskCalls.push(title);
      if (title === review.actions[1]!.title && rejectTask) {
        rejectTask = false;
        return new Response('Invalid task', { status: 422 });
      }
      return Response.json({ id: title });
    }
    if (path.endsWith('/notes')) return Response.json({ id: 'note' });
    throw Error('Unexpected URL');
  };
  try {
    await history.record(review);
    const save = () => history.writeOnce(review.runId, checkpoint => source.saveReview(review, checkpoint));
    await assert.rejects(save(), WriteNotAppliedError);
    const result = await save();
    assert.equal(result.taskIds.length, review.actions.length);
    assert.equal(taskCalls.filter(title => title === review.actions[0]!.title).length, 1);
    assert.equal(taskCalls.length, review.actions.length + 1);

    await history.record({ ...review, runId: 'uncertain' });
    let attempts = 0;
    await assert.rejects(history.writeOnce('uncertain', async () => { attempts++; throw Error('Connection lost'); }));
    await assert.rejects(history.writeOnce('uncertain', async () => { attempts++; return {}; }), /reconcile/);
    assert.equal(attempts, 1);
  } finally { globalThis.fetch = originalFetch; history.close(); }
});

test('HubSpot follows association pages, chunks reads, and rejects incomplete data', async () => {
  const originalFetch = globalThis.fetch;
  const sizes: number[] = [];
  let attempts = 0;
  let incomplete = false;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/companies/company') && ++attempts === 1) return new Response('', { status: 429 });
    if (path.endsWith('/companies/company')) return Response.json({
      id: 'company', properties: { name: 'Company', hs_csm_sentiment: 'positive' },
      associations: { tickets: {
        results: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
        paging: { next: { after: '100', link: 'https://example.invalid/next-associations' } },
      } },
    });
    if (path === '/next-associations') return Response.json({ results: [{ toObjectId: 100 }] });
    if (path.endsWith('/tickets/batch/read')) {
      const { inputs } = JSON.parse(String(init?.body)) as { inputs: { id: string }[] };
      sizes.push(inputs.length);
      return Response.json({ results: incomplete ? [] : inputs.map(({ id }) => ({
        id, properties: { hs_ticket_priority: 'HIGH', closed_date: null },
      })) });
    }
    throw Error('Unexpected URL');
  };
  try {
    const source = createDataSource(loadConfig({ DATA_SOURCE: 'hubspot', HUBSPOT_PRIVATE_APP_TOKEN: 'mock', HUBSPOT_BASE_URL: 'https://example.invalid' }));
    assert.equal((await source.getAccount('company'))?.support.urgentOpenTickets, 101);
    assert.equal(attempts, 2);
    assert.deepEqual(sizes, [100, 1]);
    incomplete = true;
    await assert.rejects(source.getAccount('company'), /incomplete/);
  } finally { globalThis.fetch = originalFetch; }
});

test('workflow approvals, persisted tool payloads, and portfolio run IDs remain usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'customer-regression-'));
  const history = new ReviewHistory(':memory:');
  let writes = 0, reads = 0, accountChanged = false;
  const data: CustomerDataSource = {
    listAccounts: () => fixtures.listAccounts(),
    getAccount: async id => {
      reads++;
      const account = await fixtures.getAccount(id);
      return account && accountChanged ? { ...account, name: account.name + ' changed' } : account;
    },
    saveReview: async review => {
      writes++;
      assert.ok(!review.summary.includes('forged'));
      return { writeId: 'note', taskIds: review.actions.map((_, i) => String(i)) };
    },
  };
  const workflow = createAccountWorkflow(data, history, agent, config);
  const weekly = createScheduledWorkflow(data, workflow, config);
  const storage = new LibSQLStore({ id: 'test', url: 'file:' + join(dir, 'mastra.db') });
  await storage.init();
  const mastra = new Mastra({ logger: false, storage, workflows: { workflow, weekly } });
  try {
    await mastra.startWorkers();
    for (const [id, outcome] of [['340739743463', 'no_action'], ['340737895140', 'insufficient_data']]) {
      const result = await (await workflow.createRun()).start({ inputData: { accountId: id! } });
      assert.equal(result.status, 'success');
      if (result.status === 'success') assert.equal(result.result.outcome, outcome);
    }
    for (const decision of ['rejected', 'approved'] as const) {
      const run = await workflow.createRun();
      assert.equal((await run.start({ inputData: { accountId: '340734348989' } })).status, 'suspended');
      // Recreate the run using its persisted ID, as existing clients do.
      const readsBeforeApproval = reads;
      const resumed = await (await workflow.createRun({ runId: run.runId })).resume({
        step: 'request-csm-approval', resumeData: { decision, approverId: 'test-csm', feedback: 'Reviewed' },
      });
      assert.equal(reads - readsBeforeApproval, decision === 'rejected' ? 0 : 1);
      assert.equal(resumed.status, 'success');
      if (resumed.status === 'success') {
        assert.equal(resumed.result.outcome, decision === 'approved' ? 'written' : 'rejected');
        assert.equal(resumed.result.approval?.approverId, 'test-csm');
        assert.equal(resumed.result.metrics.hasHumanFeedback, true);
      }
    }
    assert.equal(writes, 1);
    const run = await workflow.createRun();
    await run.start({ inputData: { accountId: '340734348989' } });
    accountChanged = true;
    const stale = await run.resume({ step: 'request-csm-approval', resumeData: { decision: 'approved', approverId: 'test-csm', feedback: 'Changed account' } });
    if (stale.status === 'success') {
      assert.equal(stale.result.outcome, 'stale_approval');
      assert.equal(stale.result.metrics.hasHumanFeedback, true);
    }
    else assert.fail('Stale approval should return a result');
    assert.equal(writes, 1);
    accountChanged = false;
    const review = assess((await fixtures.getAccount('340734348989'))!, 'tool');
    await history.record(review);
    await persistApprovedReview(data, history, { ...review, summary: 'forged', expiresAt: '2099-01-01T00:00:00Z' }, 'test-csm');
    assert.equal((await history.get('tool'))?.outcome, 'written');
    await assert.rejects(persistApprovedReview(data, history, { ...review, runId: 'unrecorded' }), /persisted/);
    const portfolio = await (await weekly.createRun()).start({ inputData: {} });
    assert.equal(portfolio.status, 'success');
    if (portfolio.status === 'success') {
      const pending = portfolio.result.results.find(result => result.status === 'awaiting_approval');
      assert.ok(pending?.runId);
    }
  } finally { await mastra.shutdown(); history.close(); await rm(dir, { recursive: true, force: true }); }
});

test('legacy table rows and write receipts survive initialization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-compatibility-'));
  const url = 'file:' + join(dir, 'history.db');
  const client = createClient({ url });
  const review = assess((await fixtures.getAccount('340734348989'))!, 'legacy');
  await client.execute(`CREATE TABLE cs_reviews (
    run_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, score INTEGER, payload TEXT NOT NULL,
    write_result TEXT, write_pending INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`);
  await client.execute({
    sql: 'INSERT INTO cs_reviews VALUES (?, ?, ?, ?, ?, 0, ?)',
    args: [review.runId, review.accountId, review.score, JSON.stringify(review), '{"writeId":"existing","taskIds":[]}', review.createdAt],
  });
  client.close();
  const history = new ReviewHistory(url);
  try {
    assert.equal((await history.get('legacy'))?.accountId, review.accountId);
    assert.deepEqual(await history.writeOnce('legacy', async () => { throw Error('Already written'); }), { writeId: 'existing', taskIds: [] });
  } finally { history.close(); await rm(dir, { recursive: true, force: true }); }
});
