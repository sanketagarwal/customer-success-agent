import { createFixtureRuntime } from '../src/mastra/adapters/fixture/fixture-runtime.js';
import { buildCustomerSuccessMonitoringReport } from '../src/mastra/monitoring/customer-success-report.js';

const runtime = await createFixtureRuntime();
const tenantId = 'demo-tenant';
const accounts = await runtime.fixtures.listAccounts(tenantId);
const prepared = await Promise.all(
  accounts.map(account =>
    runtime.service.prepare({
      runId: `monitor-${account.accountId}`,
      tenantId,
      accountId: account.accountId,
      asOf: runtime.asOf,
    }),
  ),
);
const risk = prepared.find(run => run.outcome === 'awaiting_approval');
if (!risk?.artifactHash || !risk.assessment) throw new Error('Monitoring approval fixture missing');
await runtime.service.finalize(risk, {
  decision: 'approved',
  approverId: 'fixture-csm-priya',
  decidedAt: runtime.asOf,
  expiresAt: '2026-08-24T09:00:00.000Z',
  boundToHash: risk.artifactHash,
  boundToAsOf: risk.assessment.asOf,
  feedback: 'Monitoring fixture approval feedback.',
});

const events = await runtime.store.listMonitoringEvents(tenantId);
const report = buildCustomerSuccessMonitoringReport(tenantId, events, runtime.asOf);
console.log(JSON.stringify(report, null, 2));

if (
  report.totals.assessmentRuns !== accounts.length ||
  report.totals.approvalDecisions !== 1 ||
  report.totals.outreachApprovals !== 1 ||
  report.totals.acceptedRecommendations === 0 ||
  report.totals.humanFeedbackCount !== 1 ||
  report.totals.costUsd !== 0
) {
  throw new Error('Fixture monitoring report did not contain the expected metrics');
}
