import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import { createFixtureRuntime } from '../src/mastra/adapters/fixture/fixture-runtime.js';
import { LibSqlOperationalStore } from '../src/mastra/memory/operational-stores.js';
import { buildCustomerSuccessMonitoringReport } from '../src/mastra/monitoring/customer-success-report.js';
import { approvalRequestSchema } from '../src/mastra/schemas/index.js';
import { createCrmTools } from '../src/mastra/tools/crm-tools.js';

describe('template primitives', () => {
  it('registers connector-neutral CRM tools', () => {
    const runtime = createFixtureRuntime();
    const tools = createCrmTools(runtime.fixtures, runtime.writer);
    expect(tools.listCustomerAccounts.id).toBe('list-customer-accounts');
    expect(tools.readCustomerCrmNotes.id).toBe('read-customer-crm-notes');
    expect(tools.writeApprovedCustomerSuccessDraft.id).toBe(
      'write-approved-customer-success-draft',
    );
    expect(tools.writeApprovedCustomerSuccessDraft.requireApproval).toBe(true);
  });

  it('uses Mastra step retries before returning unknown_retry', async () => {
    const runtime = createFixtureRuntime();
    const run = await runtime.accountWorkflow.createRun({ runId: 'retry-fixture' });
    const result = await run.start({
      inputData: {
        runId: 'retry-fixture',
        tenantId: 'demo-tenant',
        accountId: '340878324429',
        asOf: runtime.asOf,
      },
    });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.outcome).toBe('unknown_retry');
    const attempts = (await runtime.store.listMonitoringEvents()).filter(
      (event) => event.runId === 'retry-fixture' && event.phase === 'assessment',
    );
    expect(attempts).toHaveLength(3);
  });

  it('binds approval identity to RequestContext when supplied', async () => {
    const runtime = createFixtureRuntime();
    const run = await runtime.accountWorkflow.createRun({ runId: 'context-approval' });
    const suspended = await run.start({
      inputData: {
        runId: 'context-approval',
        tenantId: 'demo-tenant',
        accountId: '340734348989',
        asOf: runtime.asOf,
      },
    });
    expect(suspended.status).toBe('suspended');
    if (suspended.status !== 'suspended') return;
    const requestStep = suspended.steps['request-csm-approval'];
    expect(requestStep?.status).toBe('suspended');
    if (requestStep?.status !== 'suspended') return;
    const request = approvalRequestSchema.parse(requestStep.suspendPayload);
    const context = new RequestContext();
    context.set('csm-id', 'trusted-csm');
    await expect(
      run.resume({
        step: 'request-csm-approval',
        requestContext: context,
        resumeData: {
          decision: 'approved',
          approverId: 'impersonated-csm',
          decidedAt: request.requestedAt,
          expiresAt: request.expiresAt,
          boundToHash: request.artifactHash,
          boundToAsOf: request.artifactAsOf,
        },
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(runtime.writer.snapshot()).toEqual({ notes: [], tasks: [] });
  });

  it('aggregates drift, decisions, costs, latency, and feedback by account', async () => {
    const runtime = createFixtureRuntime();
    const prepared = await runtime.service.prepare({
      runId: 'monitoring-test',
      tenantId: 'demo-tenant',
      accountId: '340734348989',
      asOf: runtime.asOf,
    });
    await runtime.service.finalize(prepared, {
      decision: 'approved',
      approverId: 'fixture-csm',
      decidedAt: runtime.asOf,
      expiresAt: '2026-08-24T09:00:00.000Z',
      boundToHash: prepared.artifactHash!,
      boundToAsOf: prepared.assessment!.asOf,
      feedback: 'Approved in fixture test.',
    });
    const report = buildCustomerSuccessMonitoringReport(
      'demo-tenant',
      await runtime.store.listMonitoringEvents('demo-tenant'),
      runtime.asOf,
    );
    expect(report.totals).toMatchObject({
      assessmentRuns: 1,
      approvalDecisions: 1,
      outreachApprovals: 1,
      humanFeedbackCount: 1,
      costUsd: 0,
    });
    expect(report.totals.acceptedRecommendations).toBe(prepared.plan!.actions.length);
    expect(report.accounts[0]).toMatchObject({
      accountId: '340734348989',
      latestRiskScore: prepared.assessment!.score,
    });
  });

  it('persists monitoring events through the LibSQL operational store', async () => {
    const runtime = createFixtureRuntime();
    await runtime.service.prepare({
      runId: 'libsql-monitor-source',
      tenantId: 'demo-tenant',
      accountId: '340739743463',
      asOf: runtime.asOf,
    });
    const [event] = await runtime.store.listMonitoringEvents('demo-tenant');
    expect(event).toBeDefined();
    const store = new LibSqlOperationalStore(':memory:');
    try {
      const first = { ...event!, eventId: 'z-first', riskScore: 10 };
      const second = { ...event!, eventId: 'a-second', riskScore: 20 };
      await store.recordMonitoringEvent(first);
      await store.recordMonitoringEvent(second);
      const persisted = await store.listMonitoringEvents('demo-tenant');
      expect(persisted).toEqual([first, second]);
      expect(
        buildCustomerSuccessMonitoringReport('demo-tenant', persisted, runtime.asOf)
          .accounts[0]?.latestRiskScore,
      ).toBe(20);
    } finally {
      store.close();
    }
  });
});
