import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Mastra } from '@mastra/core/mastra';

import { loadConfig } from '../src/mastra/config.js';
import type { Reviewer } from '../src/mastra/review.js';
import type { Evidence, Proposal, Snapshot } from '../src/mastra/schemas.js';
import { createRuntime } from '../src/mastra/runtime.js';

const evidence = (source: Evidence['source'], recordId: string, field: string, value: Evidence['value']): Evidence => ({
  source, recordId, field, value,
});

export const fixtureReviewer: Reviewer = {
  async review(snapshot: Snapshot) {
    const risks: Proposal['risks'] = [];
    if (snapshot.usage.status === 'available' && snapshot.usage.data.length > 1) {
      const [first, last] = [...snapshot.usage.data].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      if (first && last && first.adoptionRate - last.adoptionRate >= 0.15) risks.push({
        id: 'declining-adoption',
        category: 'adoption',
        severity: 'critical',
        evidence: [
          evidence('usage', first.recordId, 'adoptionRate', first.adoptionRate),
          evidence('usage', last.recordId, 'adoptionRate', last.adoptionRate),
        ],
      });
    }
    const ticket = snapshot.support.status === 'available'
      ? snapshot.support.data.find(item => item.priority === 'urgent' && item.status !== 'resolved' && item.status !== 'closed')
      : undefined;
    if (ticket) risks.push({
      id: 'urgent-support-issue',
      category: 'support',
      severity: 'high',
      evidence: [evidence('support', ticket.recordId, 'status', ticket.status)],
    });
    if (snapshot.billing.status === 'available' && snapshot.billing.data.standing !== 'current') {
      const billing = snapshot.billing.data;
      risks.push({
        id: 'billing-risk',
        category: 'billing',
        severity: 'critical',
        evidence: [
          evidence('billing', billing.recordId, 'standing', billing.standing),
          evidence('billing', billing.recordId, 'daysPastDue', billing.daysPastDue),
        ],
      });
    }
    const note = snapshot.crm.status === 'available'
      ? snapshot.crm.data.find(item => item.sentiment === 'negative')
      : undefined;
    if (note) risks.push({
      id: 'negative-relationship-signal',
      category: 'relationship',
      severity: 'medium',
      evidence: [evidence('crm', note.recordId, 'sentiment', note.sentiment)],
    });
    const score = Math.max(0, 100 - risks.reduce((sum, risk) => sum + ({ low: 8, medium: 16, high: 28, critical: 42 })[risk.severity], 0));
    const status = score >= 80 ? 'healthy' : score >= 60 ? 'watch' : score >= 35 ? 'at_risk' : 'critical';
    const dueAt = new Date(Date.parse(snapshot.window.end) + 7 * 86_400_000).toISOString();
    const proposal: Proposal = {
      score,
      status,
      risks,
      actions: risks.map((risk, index) => ({
        id: `action-${index + 1}-${risk.id}`,
        owner: risk.category === 'billing' ? 'billing' : risk.category === 'support' ? 'support' : 'csm',
        dueAt,
        priority: risk.severity === 'low' || risk.severity === 'medium' ? 'medium' : 'high',
        evidence: risk.evidence,
      })),
      claims: risks.map(risk => ({ evidence: risk.evidence })),
    };
    return { proposal, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  },
};

export async function testRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-cs-'));
  const config = loadConfig({
    CRM_PROVIDER: 'fixture',
    FIXTURE_PATH: resolve('data/fixtures/accounts.json'),
    FIXTURE_NOW: '2026-08-17T09:00:00.000Z',
    MASTRA_DB_URL: `file:${join(directory, 'runtime.db')}`,
  });
  const runtime = createRuntime(config, { reviewer: fixtureReviewer });
  const mastra = new Mastra({
    storage: runtime.storage,
    workflows: { account: runtime.accountWorkflow, scheduled: runtime.scheduledWorkflow },
  });
  await mastra.getStorage()?.init();
  return {
    ...runtime,
    config,
    mastra,
    async cleanup() {
      runtime.state.close?.();
      await mastra.getStorage()?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
