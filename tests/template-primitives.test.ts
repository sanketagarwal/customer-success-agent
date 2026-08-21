import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';

import { createFixtureRuntime } from '../src/mastra/adapters/fixture/fixture-runtime.js';
import { createConnectors } from '../src/mastra/composition/create-connectors.js';
import { loadConfig } from '../src/mastra/config.js';
import { LibSqlOperationalStore } from '../src/mastra/memory/operational-stores.js';
import { buildCustomerSuccessMonitoringReport } from '../src/mastra/monitoring/customer-success-report.js';
import { approvalRequestSchema } from '../src/mastra/schemas/index.js';
import { createCrmTools } from '../src/mastra/tools/crm-tools.js';
import { accountRunInputSchema, approvalResumeSchema } from '../src/mastra/workflows/account-workflow.js';
import { scheduledInputSchema } from '../src/mastra/workflows/scheduled-workflow.js';

describe('template primitives', () => {
  it('uses model-backed generation for the Studio runtime by default', () => {
    expect(loadConfig({}).generationMode).toBe('model');
  });

  it('allows every data source to be replaced independently', async () => {
    const runtime = await createFixtureRuntime();
    const store = new LibSqlOperationalStore(':memory:');
    try {
      const connectors = createConnectors(loadConfig({ CRM_PROVIDER: 'fixture', MASTRA_DB_URL: ':memory:' }), store, {
        usage: runtime.fixtures,
        support: runtime.fixtures,
        billing: runtime.fixtures,
        crm: runtime.fixtures,
        crmWriter: runtime.writer,
        clock: runtime.clock,
      });

      expect(connectors).toMatchObject({
        usage: runtime.fixtures,
        support: runtime.fixtures,
        billing: runtime.fixtures,
        crm: runtime.fixtures,
        crmWriter: runtime.writer,
        clock: runtime.clock,
      });
    } finally {
      store.close();
    }
  });

  it('registers connector-neutral CRM tools', async () => {
    const runtime = await createFixtureRuntime();
    const tools = createCrmTools(runtime.fixtures, runtime.writer);
    expect(tools.listCustomerAccounts.id).toBe('list-customer-accounts');
    expect(tools.readCustomerCrmNotes.id).toBe('read-customer-crm-notes');
    expect(tools.writeApprovedCustomerSuccessDraft.id).toBe('write-approved-customer-success-draft');
    expect(tools.writeApprovedCustomerSuccessDraft.requireApproval).toBe(true);
  });

  it('exposes source reads, processing, approval, and CRM writes as workflow steps', async () => {
    const runtime = await createFixtureRuntime();
    expect(Object.keys(runtime.accountWorkflow.steps)).toEqual(
      expect.arrayContaining([
        'initialize-account-review',
        'read-product-usage',
        'read-support-history',
        'read-billing-status',
        'read-crm-notes',
        'assemble-source-snapshot',
        'assess-account-health',
        'calculate-risk-drift',
        'create-account-plan',
        'draft-personalized-outreach',
        'bind-approval-artifacts',
        'record-assessment-monitoring',
        'request-csm-approval',
        'validate-approval-freshness',
        'create-crm-follow-up-tasks',
        'create-crm-internal-note',
        'record-approval-monitoring',
      ]),
    );
  });

  it('keeps scheduled, manual, and approval forms free of workflow plumbing', () => {
    expect(Object.keys(scheduledInputSchema.shape)).toEqual([]);
    expect(Object.keys(accountRunInputSchema.shape)).toEqual(['accountId']);
    expect(accountRunInputSchema.parse({})).toEqual({ accountId: '340734348989' });
    expect(Object.keys(approvalResumeSchema.shape)).toEqual(['decision', 'approverId', 'feedback']);
  });

  it('runs the at-risk demo account from the Studio schema default', async () => {
    const runtime = await createFixtureRuntime();
    const run = await runtime.accountWorkflow.createRun({ runId: 'studio-one-click' });
    const result = await run.start({ inputData: accountRunInputSchema.parse({}) });
    expect(result.status).toBe('suspended');
    if (result.status !== 'suspended') return;
    expect(result.steps['initialize-account-review']).toMatchObject({
      status: 'success',
      output: { accountId: '340734348989' },
    });
    expect(result.steps['request-csm-approval']?.status).toBe('suspended');
  });

  it('uses Mastra step retries before returning unknown_retry', async () => {
    const runtime = await createFixtureRuntime();
    const supportReads = vi.spyOn(runtime.service, 'readSupport');
    const run = await runtime.accountWorkflow.createRun({ runId: 'retry-fixture' });
    const result = await run.start({
      inputData: {
        accountId: '340878324429',
      },
    });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.outcome).toBe('unknown_retry');
    expect(supportReads).toHaveBeenCalledTimes(3);
    const events = (await runtime.store.listMonitoringEvents()).filter(
      event => event.runId === 'retry-fixture' && event.phase === 'assessment',
    );
    expect(events).toHaveLength(1);
  });

  it('retries each model-backed generation stage independently', async () => {
    const runtime = await createFixtureRuntime();
    const originalAssess = runtime.service.assessHealth.bind(runtime.service);
    const originalPlan = runtime.service.createPlan.bind(runtime.service);
    const originalDraft = runtime.service.draftOutreach.bind(runtime.service);
    const assess = vi
      .spyOn(runtime.service, 'assessHealth')
      .mockRejectedValueOnce(new Error('transient assessment failure'))
      .mockImplementation(originalAssess);
    const plan = vi
      .spyOn(runtime.service, 'createPlan')
      .mockRejectedValueOnce(new Error('transient planning failure'))
      .mockImplementation(originalPlan);
    const draft = vi
      .spyOn(runtime.service, 'draftOutreach')
      .mockRejectedValueOnce(new Error('transient outreach failure'))
      .mockImplementation(originalDraft);

    const run = await runtime.accountWorkflow.createRun({ runId: 'generation-retries' });
    const result = await run.start({ inputData: { accountId: '340734348989' } });

    expect(result.status).toBe('suspended');
    expect(assess).toHaveBeenCalledTimes(2);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(draft).toHaveBeenCalledTimes(2);
  });

  it('binds approval identity to RequestContext when supplied', async () => {
    const runtime = await createFixtureRuntime();
    const run = await runtime.accountWorkflow.createRun({ runId: 'context-approval' });
    const suspended = await run.start({
      inputData: {
        accountId: '340734348989',
      },
    });
    expect(suspended.status).toBe('suspended');
    if (suspended.status !== 'suspended') return;
    const requestStep = suspended.steps['request-csm-approval'];
    expect(requestStep?.status).toBe('suspended');
    if (requestStep?.status !== 'suspended') return;
    expect(() => approvalRequestSchema.parse(requestStep.suspendPayload)).not.toThrow();
    const context = new RequestContext();
    context.set('csm-id', 'trusted-csm');
    await expect(
      run.resume({
        step: 'request-csm-approval',
        requestContext: context,
        resumeData: {
          decision: 'approved',
          approverId: 'impersonated-csm',
        },
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(runtime.writer.snapshot()).toEqual({ notes: [], tasks: [] });
  });

  it('aggregates drift, decisions, costs, latency, and feedback by account', async () => {
    const runtime = await createFixtureRuntime();
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
    const runtime = await createFixtureRuntime();
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
        buildCustomerSuccessMonitoringReport('demo-tenant', persisted, runtime.asOf).accounts[0]?.latestRiskScore,
      ).toBe(20);
    } finally {
      store.close();
    }
  });
});
