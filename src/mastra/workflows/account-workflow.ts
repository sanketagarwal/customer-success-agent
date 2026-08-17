import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { Composition } from '../composition/create-composition.js';
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

export function createAccountWorkflow(composition: Composition) {
  const prepareAccount = createStep({
    id: 'prepare-account-review',
    inputSchema: accountRunInputSchema,
    outputSchema: preparedRunSchema,
    execute: async ({ inputData, requestContext }) => {
      const contextTenant = requestContext.get('tenant-id');
      const contextAccount = requestContext.get('account-id');
      if (contextTenant && contextTenant !== inputData.tenantId) throw new Error('tenant RequestContext mismatch');
      if (contextAccount && contextAccount !== inputData.accountId) throw new Error('account RequestContext mismatch');
      return composition.service.prepare({
        runId: inputData.runId,
        tenantId: inputData.tenantId,
        accountId: inputData.accountId,
        ...(inputData.asOf ? { asOf: inputData.asOf } : {}),
      });
    },
  });

  const requestApproval = createStep({
    id: 'request-csm-approval',
    inputSchema: preparedRunSchema,
    outputSchema: approvalStepOutputSchema,
    resumeSchema: approvalDecisionSchema,
    suspendSchema: approvalRequestSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.outcome !== 'awaiting_approval') return { prepared: inputData, decision: null };
      if (!resumeData) {
        const request = await composition.operationalStore.getRequest(inputData.runId);
        if (!request) throw new Error(`Approval request ${inputData.runId} was not persisted`);
        return suspend(request);
      }
      return { prepared: inputData, decision: resumeData };
    },
  });

  const writeApprovedDraft = createStep({
    id: 'write-approved-crm-draft',
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
