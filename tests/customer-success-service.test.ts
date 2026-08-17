import { describe, expect, it } from 'vitest';

import { scopeKey } from '../src/mastra/invariants/index.js';
import type { ApprovalDecision } from '../src/mastra/schemas/index.js';
import { checkAssessmentGrounding } from '../src/mastra/services/grounding.js';
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
});
