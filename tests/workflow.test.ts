import { RequestContext } from '@mastra/core/request-context';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFixtureRuntime } from '../src/mastra/runtime.js';
import { monitoringSummary } from '../src/mastra/state.js';
import { accountInputSchema, approvalSchema } from '../src/mastra/workflows.js';

const runtimes: Awaited<ReturnType<typeof createFixtureRuntime>>[] = [];
const runtime = async () => {
  const value = await createFixtureRuntime();
  runtimes.push(value);
  return value;
};

afterEach(async () => Promise.all(runtimes.splice(0).map(value => value.cleanup())));

describe('customer-success workflow', () => {
  it('is a four-step, one-input Studio workflow', async () => {
    const app = await runtime();
    expect(Object.keys(app.accountWorkflow.steps)).toEqual([
      'collect-account-data',
      'prepare-account-review',
      'request-csm-approval',
      'update-crm-and-schedule-follow-ups',
    ]);
    expect(accountInputSchema.parse({})).toEqual({ accountId: '340734348989' });
    expect(Object.keys(approvalSchema.shape)).toEqual(['decision', 'approverId', 'feedback']);
  });

  it('handles healthy, at-risk, sparse, and unavailable fixture accounts', async () => {
    const app = await runtime();
    const cases = [
      ['340739743463', 'success', 'no_action'],
      ['340734348989', 'suspended', 'awaiting_approval'],
      ['340737895140', 'success', 'insufficient_data'],
      ['340878324429', 'success', 'unknown_retry'],
    ] as const;
    for (const [accountId, status, outcome] of cases) {
      const run = await app.accountWorkflow.createRun({ runId: `case-${accountId}` });
      const result = await run.start({ inputData: { accountId } });
      expect(result.status).toBe(status);
      if (result.status === 'success') expect(result.result.outcome).toBe(outcome);
      if (result.status === 'suspended') {
        expect(result.steps['prepare-account-review']).toMatchObject({ output: { outcome } });
      }
    }
  });

  it('retries unavailable data and then reports a retryable outcome', async () => {
    const app = await runtime();
    const readSupport = vi.spyOn(app.connectors, 'readSupport');
    const run = await app.accountWorkflow.createRun({ runId: 'retry-source' });
    const result = await run.start({ inputData: { accountId: '340878324429' } });
    expect(result).toMatchObject({ status: 'success', result: { outcome: 'unknown_retry' } });
    expect(readSupport).toHaveBeenCalledTimes(3);
  });

  it('approves with only a decision and approver ID, then writes CRM output', async () => {
    const app = await runtime();
    const run = await app.accountWorkflow.createRun({ runId: 'approval' });
    expect(await run.start({ inputData: accountInputSchema.parse({}) })).toMatchObject({ status: 'suspended' });
    const result = await run.resume({
      step: 'request-csm-approval',
      resumeData: { decision: 'approved', approverId: 'demo-csm', feedback: 'Approved.' },
    });
    expect(result).toMatchObject({
      status: 'success',
      result: { outcome: 'written', crm: { created: true } },
    });
    if (result.status === 'success') expect(result.result.crm?.taskIds.length).toBeGreaterThan(0);
    const events = await app.state.events('demo-tenant');
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      outreachApproved: true,
      feedback: true,
      acceptedRecommendations: 4,
    });
    expect(monitoringSummary(events)).toMatchObject({
      totals: { reviews: 1, approvals: 1, outreachApprovals: 1 },
      accounts: [{ accountId: '340734348989', riskScore: 0 }],
    });
  });

  it('does not update CRM after rejection', async () => {
    const app = await runtime();
    const run = await app.accountWorkflow.createRun({ runId: 'rejection' });
    await run.start({ inputData: accountInputSchema.parse({}) });
    const result = await run.resume({
      step: 'request-csm-approval',
      resumeData: { decision: 'rejected', approverId: 'demo-csm' },
    });
    expect(result).toMatchObject({ status: 'success', result: { outcome: 'rejected', crm: null } });
  });

  it('enforces request and approver identity when context is supplied', async () => {
    const app = await runtime();
    const wrongAccount = new RequestContext();
    wrongAccount.set('account-id', 'another-account');
    const first = await app.accountWorkflow.createRun({ runId: 'wrong-account' });
    expect(await first.start({ inputData: accountInputSchema.parse({}), requestContext: wrongAccount })).toMatchObject({ status: 'failed' });

    const second = await app.accountWorkflow.createRun({ runId: 'wrong-approver' });
    await second.start({ inputData: accountInputSchema.parse({}) });
    const approver = new RequestContext();
    approver.set('csm-id', 'trusted-csm');
    expect(await second.resume({
      step: 'request-csm-approval',
      requestContext: approver,
      resumeData: { decision: 'approved', approverId: 'someone-else' },
    })).toMatchObject({ status: 'failed' });
  });

  it('isolates persisted workflow runs between fixture runtimes', async () => {
    const first = await runtime();
    const second = await runtime();
    const run = await first.accountWorkflow.createRun({ runId: 'isolated-run' });
    await run.start({ inputData: accountInputSchema.parse({}) });
    const store = await second.mastra.getStorage()?.getStore('workflows');
    await expect(store?.loadWorkflowSnapshot({ workflowName: 'customer-success-account', runId: 'isolated-run' }))
      .resolves.toBeNull();
  });
});
