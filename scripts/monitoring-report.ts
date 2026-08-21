import { createFixtureRuntime } from '../src/mastra/runtime.js';
import { monitoringSummary } from '../src/mastra/state.js';
import { accountInputSchema } from '../src/mastra/workflows.js';

const runtime = await createFixtureRuntime();
try {
  const run = await runtime.accountWorkflow.createRun({ runId: 'monitoring-demo' });
  await run.start({ inputData: accountInputSchema.parse({}) });
  await run.resume({
    step: 'request-csm-approval',
    resumeData: { decision: 'approved', approverId: 'demo-csm', feedback: 'Approved.' },
  });
  const summary = monitoringSummary(await runtime.state.events('demo-tenant'));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.reviews !== 1 || summary.approvals !== 1 || summary.outreachApprovals !== 1 || !summary.humanFeedback) {
    throw new Error('Monitoring demo did not record the expected metrics');
  }
} finally {
  await runtime.cleanup();
}
