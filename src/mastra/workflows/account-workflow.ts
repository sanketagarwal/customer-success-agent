import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { Composition } from '../composition/create-composition.js';
import { ProviderUnavailableError } from '../errors/provider-unavailable-error.js';
import type { ApprovalStore } from '../ports/index.js';
import {
  approvalDecisionSchema,
  approvalRequestSchema,
  preparedRunSchema,
} from '../schemas/index.js';

export const accountRunInputSchema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  asOf: z.iso.datetime({ offset: true }).optional(),
});

const approvalStepOutputSchema = z.object({
  prepared: preparedRunSchema,
  decision: approvalDecisionSchema.nullable(),
});

export const accountRunOutputSchema = preparedRunSchema.extend({
  writeId: z.string().nullable(),
  created: z.boolean().nullable(),
});

type AccountWorkflowDependencies = Pick<Composition, 'service'> & {
  operationalStore: Pick<ApprovalStore, 'getRequest'>;
};

export function createAccountWorkflow(composition: AccountWorkflowDependencies) {
  const prepareAccount = createStep({
    id: 'prepare-account-review',
    description: 'Collect account signals and prepare a grounded customer-success review.',
    inputSchema: accountRunInputSchema,
    outputSchema: preparedRunSchema,
    retries: 2,
    execute: async ({ inputData, requestContext, retryCount }) => {
      const contextTenant = requestContext.get('tenant-id');
      const contextAccount = requestContext.get('account-id');
      if (contextTenant && contextTenant !== inputData.tenantId) {
        throw new Error('tenant RequestContext mismatch');
      }
      if (contextAccount && contextAccount !== inputData.accountId) {
        throw new Error('account RequestContext mismatch');
      }
      const prepared = await composition.service.prepare({
        runId: inputData.runId,
        tenantId: inputData.tenantId,
        accountId: inputData.accountId,
        ...(inputData.asOf ? { asOf: inputData.asOf } : {}),
      });
      if (prepared.outcome === 'unknown_retry' && retryCount < 2) {
        throw new ProviderUnavailableError(
          'customer-success-sources',
          `Retryable source failure on workflow attempt ${retryCount + 1}`,
        );
      }
      return prepared;
    },
  });

  const requestApproval = createStep({
    id: 'request-csm-approval',
    description:
      'Suspend risky-account execution until a CSM approves or rejects the bound artifacts.',
    inputSchema: preparedRunSchema,
    outputSchema: approvalStepOutputSchema,
    resumeSchema: approvalDecisionSchema,
    suspendSchema: approvalRequestSchema,
    execute: async ({ inputData, resumeData, suspend, requestContext }) => {
      if (inputData.outcome !== 'awaiting_approval') return { prepared: inputData, decision: null };
      if (!resumeData) {
        const request = await composition.operationalStore.getRequest(inputData.runId);
        if (!request) throw new Error(`Approval request ${inputData.runId} was not persisted`);
        return suspend(request);
      }
      const contextApprover = requestContext.get('csm-id');
      if (contextApprover && contextApprover !== resumeData.approverId) {
        throw new Error('approver RequestContext mismatch');
      }
      return { prepared: inputData, decision: resumeData };
    },
  });

  const writeApprovedDraft = createStep({
    id: 'write-approved-crm-draft',
    description:
      'Validate approval freshness and write the approved internal CRM draft exactly once.',
    inputSchema: approvalStepOutputSchema,
    outputSchema: accountRunOutputSchema,
    execute: async ({ inputData }) => {
      if (!inputData.decision) {
        return { ...inputData.prepared, writeId: null, created: null };
      }
      const finalized = await composition.service.finalize(inputData.prepared, inputData.decision);
      return {
        ...finalized.run,
        writeId: finalized.write?.writeId ?? null,
        created: finalized.write?.created ?? null,
      };
    },
  });

  return createWorkflow({
    id: 'customer-success-account',
    inputSchema: accountRunInputSchema,
    outputSchema: accountRunOutputSchema,
  })
    .then(prepareAccount)
    .then(requestApproval)
    .then(writeApprovedDraft)
    .commit();
}
