import { describe, expect, it } from 'vitest';

import { DeterministicCustomerSuccessIntelligence } from '../src/mastra/adapters/fixture/deterministic-intelligence.js';
import { scopeKey } from '../src/mastra/invariants/index.js';
import type { Clock, CrmRepository, CustomerSuccessIntelligence } from '../src/mastra/ports/index.js';
import type { ApprovalDecision } from '../src/mastra/schemas/index.js';
import {
  checkAssessmentGrounding,
  checkOutreachGrounding,
  checkPlanGrounding,
} from '../src/mastra/services/grounding.js';
import { createTestSystem, fixtureAsOf } from './helpers.js';

describe('customer success service', () => {
  it('produces the expected fixture dispositions', async () => {
    const { service } = createTestSystem();
    const cases = [
      ['company-healthy', 'no_action'],
      ['company-declining', 'awaiting_approval'],
      ['company-insufficient', 'insufficient_data'],
      ['company-provider-down', 'unknown_retry'],
    ] as const;

    for (const [accountId, outcome] of cases) {
      const result = await service.prepare({
        runId: `run-${accountId}`,
        tenantId: 'demo-tenant',
        accountId,
        asOf: fixtureAsOf,
      });
      expect(result.outcome).toBe(outcome);
    }
  });

  it('rejects a deliberately fabricated risk-factor reference', async () => {
    const { service } = createTestSystem();
    const prepared = await service.prepare({
      runId: 'fabrication-test',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    expect(prepared.assessment).not.toBeNull();
    const snapshot = await service.collect('demo-tenant', 'company-declining', {
      start: '2026-07-20T09:00:00.000Z',
      end: fixtureAsOf,
    });
    const fabricated = structuredClone(prepared.assessment!);
    fabricated.riskFactors[0]!.evidence[0]!.ref.recordId = 'invented-record';
    expect(checkAssessmentGrounding(fabricated, snapshot)).toEqual({
      grounded: false,
      unresolved: ['riskFactors[0].evidence[0]'],
    });

    const fabricatedValue = structuredClone(prepared.assessment!);
    fabricatedValue.riskFactors[0]!.evidence[0]!.value = 'fabricated-value';
    expect(checkAssessmentGrounding(fabricatedValue, snapshot)).toMatchObject({
      grounded: false,
      unresolved: expect.arrayContaining([
        'riskFactors[0].evidence[0]',
        'riskFactors[0].explanation',
      ]),
    });

    const fabricatedSummary = structuredClone(prepared.assessment!);
    fabricatedSummary.summary = 'The customer explicitly promised to churn tomorrow.';
    expect(checkAssessmentGrounding(fabricatedSummary, snapshot)).toMatchObject({
      grounded: false,
      unresolved: ['summary'],
    });

    const fabricatedPlan = structuredClone(prepared.plan!);
    fabricatedPlan.actions[0]!.rationale = 'This unsupported action is definitely required.';
    expect(checkPlanGrounding(fabricatedPlan, snapshot)).toMatchObject({
      grounded: false,
      unresolved: ['actions[0].rationale'],
    });

    const fabricatedOutreach = structuredClone(prepared.outreach!);
    fabricatedOutreach.body = 'The customer promised to cancel tomorrow.';
    expect(checkOutreachGrounding(fabricatedOutreach, snapshot)).toMatchObject({
      grounded: false,
      unresolved: ['body'],
    });
  });

  it('makes request identity authoritative over model-generated identity', async () => {
    const deterministic = new DeterministicCustomerSuccessIntelligence();
    const malicious: CustomerSuccessIntelligence = {
      async assess(input) {
        return {
          ...(await deterministic.assess(input)),
          tenantId: 'victim-tenant',
          accountId: 'victim-account',
          asOf: '2025-01-01T00:00:00.000Z',
        };
      },
      async plan(input) {
        return {
          ...(await deterministic.plan(input)),
          tenantId: 'victim-tenant',
          accountId: 'victim-account',
          asOf: '2025-01-01T00:00:00.000Z',
        };
      },
      async draftOutreach(input) {
        return {
          ...(await deterministic.draftOutreach(input)),
          tenantId: 'victim-tenant',
          accountId: 'victim-account',
          asOf: '2025-01-01T00:00:00.000Z',
        };
      },
    };
    const { service, store } = createTestSystem({ intelligence: malicious });
    const prepared = await service.prepare({
      runId: 'model-identity-isolation',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });

    expect(prepared.assessment).toMatchObject({
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    expect(prepared.plan).toMatchObject({
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    expect(prepared.outreach).toMatchObject({
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    expect(await store.get('victim-tenant', 'victim-account')).toBeNull();
    expect(await store.get('demo-tenant', 'company-declining')).not.toBeNull();
  });

  it('creates a baseline, then calculates stable drift and persistent factors', async () => {
    const { service } = createTestSystem();
    const first = await service.prepare({
      runId: 'drift-1',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    const second = await service.prepare({
      runId: 'drift-2',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    expect(first.drift?.baseline).toBe(true);
    expect(second.drift).toMatchObject({ baseline: false, direction: 'stable', scoreDelta: 0 });
    expect(second.drift?.factorChanges.every((change) => change.status === 'persistent')).toBe(true);
  });

  it('keeps account memory isolated by tenant and account', async () => {
    const { service, store } = createTestSystem();
    await service.prepare({
      runId: 'isolation-a',
      tenantId: 'demo-tenant',
      accountId: 'company-healthy',
      asOf: fixtureAsOf,
    });
    expect(await store.get('demo-tenant', 'company-healthy')).not.toBeNull();
    expect(await store.get('demo-tenant', 'company-declining')).toBeNull();
    expect(scopeKey('tenant-a', 'same')).not.toBe(scopeKey('tenant-b', 'same'));
  });

  it('writes once after a current approval and deduplicates a replay', async () => {
    const { service } = createTestSystem();
    const prepared = await service.prepare({
      runId: 'approval-write',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    const decision: ApprovalDecision = {
      decision: 'approved',
      approverId: 'csm-priya',
      decidedAt: fixtureAsOf,
      expiresAt: '2026-08-20T09:00:00.000Z',
      boundToHash: prepared.artifactHash!,
      boundToAsOf: prepared.assessment!.asOf,
    };
    const first = await service.finalize(prepared, decision);
    const replay = await service.finalize(prepared, decision);
    expect(first.run.outcome).toBe('written');
    expect(first.write?.created).toBe(true);
    expect(replay.write).toMatchObject({ created: false, writeId: first.write?.writeId });
  });

  it('never writes rejected or stale approvals', async () => {
    const rejectedSystem = createTestSystem();
    const rejected = await rejectedSystem.service.prepare({
      runId: 'approval-reject',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    const rejection = await rejectedSystem.service.finalize(rejected, {
      decision: 'rejected',
      approverId: 'csm-priya',
      decidedAt: fixtureAsOf,
      expiresAt: '2026-08-20T09:00:00.000Z',
      boundToHash: rejected.artifactHash!,
      boundToAsOf: rejected.assessment!.asOf,
    });
    expect(rejection).toMatchObject({ run: { outcome: 'rejected' }, write: null });

    const staleSystem = createTestSystem();
    const stale = await staleSystem.service.prepare({
      runId: 'approval-stale',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    const staleResult = await staleSystem.service.finalize(stale, {
      decision: 'approved',
      approverId: 'csm-priya',
      decidedAt: fixtureAsOf,
      expiresAt: '2026-08-20T09:00:00.000Z',
      boundToHash: '0'.repeat(64),
      boundToAsOf: stale.assessment!.asOf,
    });
    expect(staleResult).toMatchObject({ run: { outcome: 'stale_approval' }, write: null });
  });

  it('invalidates approval when a source record arrives after assessment', async () => {
    let now = fixtureAsOf;
    const clock: Clock = { now: () => new Date(now) };
    const system = createTestSystem({ clock });
    const baseCrm = system.fixtures;
    const crm: CrmRepository = {
      listAccounts: (tenantId) => baseCrm.listAccounts(tenantId),
      async getCrmNotes(query) {
        const result = await baseCrm.getCrmNotes(query);
        if (query.window.end === fixtureAsOf || result.status !== 'available') return result;
        return {
          status: 'available',
          data: {
            ...result.data,
            window: query.window,
            notes: [
              ...result.data.notes,
              {
                recordId: 'post-assessment-note',
                createdAt: '2026-08-18T08:00:00.000Z',
                authorId: 'csm-priya',
                body: 'A new renewal concern was reported.',
                sentiment: 'negative',
              },
            ],
          },
        };
      },
    };
    system.dependencies.crm = crm;
    const prepared = await system.service.prepare({
      runId: 'approval-new-source',
      tenantId: 'demo-tenant',
      accountId: 'company-declining',
      asOf: fixtureAsOf,
    });
    now = '2026-08-18T09:00:00.000Z';
    const result = await system.service.finalize(prepared, {
      decision: 'approved',
      approverId: 'csm-priya',
      decidedAt: now,
      expiresAt: '2026-08-20T09:00:00.000Z',
      boundToHash: prepared.artifactHash!,
      boundToAsOf: prepared.assessment!.asOf,
    });
    expect(result).toMatchObject({ run: { outcome: 'stale_approval' }, write: null });
  });
});
