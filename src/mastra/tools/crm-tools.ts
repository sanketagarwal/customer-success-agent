import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { CrmRepository, CrmWriter } from '../ports/index.js';
import {
  accountSchema,
  crmNotesSchema,
  crmWriteInputSchema,
  crmWriteResultSchema,
  sourceReadResultSchema,
  timeWindowSchema,
} from '../schemas/index.js';

export function createCrmTools(crm: CrmRepository, crmWriter: CrmWriter) {
  const listCustomerAccounts = createTool({
    id: 'list-customer-accounts',
    description: 'List normalized customer accounts from the configured CRM adapter.',
    inputSchema: z.object({ tenantId: z.string().min(1) }),
    outputSchema: z.array(accountSchema),
    execute: async ({ tenantId }) => [...(await crm.listAccounts(tenantId))],
    mcp: {
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  });

  const readCustomerCrmNotes = createTool({
    id: 'read-customer-crm-notes',
    description: 'Read normalized CRM notes for one tenant-scoped customer account and time window.',
    inputSchema: z.object({
      tenantId: z.string().min(1),
      accountId: z.string().min(1),
      window: timeWindowSchema,
    }),
    outputSchema: sourceReadResultSchema(crmNotesSchema),
    execute: (input) => crm.getCrmNotes(input),
    mcp: {
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  });

  const writeApprovedCustomerSuccessDraft = createTool({
    id: 'write-approved-customer-success-draft',
    description:
      'Write an already approved customer-success draft and its follow-up actions through the configured CRM adapter.',
    inputSchema: crmWriteInputSchema,
    outputSchema: crmWriteResultSchema,
    requireApproval: true,
    execute: (input) => crmWriter.writeApprovedDraft(input),
    mcp: {
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  });

  return {
    listCustomerAccounts,
    readCustomerCrmNotes,
    writeApprovedCustomerSuccessDraft,
  };
}

export type CustomerSuccessCrmTools = ReturnType<typeof createCrmTools>;
