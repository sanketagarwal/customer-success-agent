import { RequestContext } from '@mastra/core/request-context';

import { createFixtureRuntime } from '../src/mastra/adapters/fixture/fixture-runtime.js';
import { approvalRequestSchema, preparedRunSchema, type ApprovalDecision } from '../src/mastra/schemas/index.js';
import { executeScheduledAccountReviews } from '../src/mastra/workflows/scheduled-workflow.js';

const runtime = createFixtureRuntime();
const tenantId = 'demo-tenant';
const batch = await executeScheduledAccountReviews(
  {
    crm: runtime.fixtures,
    config: {
      maxAccountConcurrency: 4,
      cron: '0 9 * * 1',
      timezone: 'UTC',
      tenantId,
    },
  },
  runtime.accountWorkflow,
  {},
);

const approvalRunId = 'fixture-approval-demo';
const approvalRun = await runtime.accountWorkflow.createRun({ runId: approvalRunId });
const accountContext = new RequestContext();
accountContext.set('tenant-id', tenantId);
accountContext.set('account-id', '340734348989');
const prepared = await approvalRun.start({
  inputData: {
    accountId: '340734348989',
  },
  requestContext: accountContext,
});
if (prepared.status !== 'suspended') {
  throw new Error(`Expected approval suspension, received ${prepared.status}`);
}
const requestStep = prepared.steps['request-csm-approval'];
if (requestStep?.status !== 'suspended') throw new Error('Fixture approval step did not suspend');
const request = approvalRequestSchema.parse(requestStep.suspendPayload);

const decision: ApprovalDecision = {
  decision: 'approved',
  approverId: 'fixture-csm-priya',
  decidedAt: request.requestedAt,
  expiresAt: request.expiresAt,
  boundToHash: request.artifactHash,
  boundToAsOf: request.artifactAsOf,
  feedback: 'Fixture CSM approved the grounded plan.',
};
const approvalContext = new RequestContext();
approvalContext.set('tenant-id', tenantId);
approvalContext.set('account-id', request.accountId);
approvalContext.set('csm-id', decision.approverId);
const approved = await approvalRun.resume({
  step: 'request-csm-approval',
  resumeData: decision,
  requestContext: approvalContext,
});
if (approved.status !== 'success' || approved.result.outcome !== 'written') {
  throw new Error(`Fixture approval did not write: ${approved.status}`);
}

const prepareStep = prepared.steps['record-assessment-monitoring'];
if (prepareStep?.status !== 'success') throw new Error('Prepared fixture output was missing');
const preparedOutput = preparedRunSchema.parse(prepareStep.output);
const replay = await runtime.service.finalize(preparedOutput, decision);

const rejectionRunId = 'fixture-rejection-demo';
const rejectionRun = await runtime.accountWorkflow.createRun({ runId: rejectionRunId });
const rejectionPrepared = await rejectionRun.start({
  inputData: {
    accountId: '340734348989',
  },
  requestContext: accountContext,
});
if (rejectionPrepared.status !== 'suspended') throw new Error('Expected rejection suspension');
const rejectionStep = rejectionPrepared.steps['request-csm-approval'];
if (rejectionStep?.status !== 'suspended') throw new Error('Fixture rejection step did not suspend');
const rejectionRequest = approvalRequestSchema.parse(rejectionStep.suspendPayload);
const rejected = await rejectionRun.resume({
  step: 'request-csm-approval',
  resumeData: {
    decision: 'rejected',
    approverId: 'fixture-csm-priya',
    decidedAt: rejectionRequest.requestedAt,
    expiresAt: rejectionRequest.expiresAt,
    boundToHash: rejectionRequest.artifactHash,
    boundToAsOf: rejectionRequest.artifactAsOf,
    feedback: 'Fixture CSM requested revisions.',
  },
  requestContext: approvalContext,
});
if (rejected.status !== 'success' || rejected.result.outcome !== 'rejected') {
  throw new Error(`Fixture rejection failed with ${rejected.status}`);
}

console.log(
  JSON.stringify(
    {
      schedule: {
        cron: '0 9 * * 1',
        timezone: 'UTC',
        batch,
      },
      approval: {
        suspendedAt: 'request-csm-approval',
        request,
        outcome: approved.result.outcome,
        writeId: approved.result.writeId,
        created: approved.result.created,
        taskIds: approved.result.taskIds,
        tasksCreated: approved.result.tasksCreated,
        tasksReused: approved.result.tasksReused,
      },
      rejection: { outcome: rejected.result.outcome, writeId: rejected.result.writeId },
      replay: {
        outcome: replay.run.outcome,
        created: replay.write?.created ?? null,
        writeId: replay.write?.writeId ?? null,
      },
      crm: runtime.writer.snapshot(),
    },
    null,
    2,
  ),
);
