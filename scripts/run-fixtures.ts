import { createFixtureRuntime } from '../src/mastra/runtime.js';
import { accountInputSchema } from '../src/mastra/workflows.js';

const runtime = await createFixtureRuntime();
try {
  const accounts = ['340739743463', '340737895140', '340878324429'] as const;
  const outcomes = Object.fromEntries(await Promise.all(accounts.map(async accountId => {
    const run = await runtime.accountWorkflow.createRun({ runId: `demo-${accountId}` });
    const result = await run.start({ inputData: { accountId } });
    if (result.status !== 'success') throw new Error(`${accountId} ended with ${result.status}`);
    return [accountId, result.result.outcome];
  })));

  const approval = await runtime.accountWorkflow.createRun({ runId: 'demo-approval' });
  const suspended = await approval.start({ inputData: accountInputSchema.parse({}) });
  if (suspended.status !== 'suspended') throw new Error(`Approval demo ended with ${suspended.status}`);
  const approved = await approval.resume({
    step: 'request-csm-approval',
    resumeData: { decision: 'approved', approverId: 'demo-csm', feedback: 'Approved in fixture demo.' },
  });
  if (approved.status !== 'success' || approved.result.outcome !== 'written') {
    throw new Error(`Approval demo ended with ${approved.status}`);
  }
  console.log(JSON.stringify({
    outcomes,
    approval: {
      outcome: approved.result.outcome,
      noteId: approved.result.crm?.noteId,
      taskIds: approved.result.crm?.taskIds,
    },
  }, null, 2));
} finally {
  await runtime.cleanup();
}
