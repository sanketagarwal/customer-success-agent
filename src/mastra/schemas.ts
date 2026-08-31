import { z } from 'zod';
export const isoDate = z.iso.datetime({ offset: true });
const signalName = z.enum(['usage', 'support', 'billing', 'crm']);
export const accountSignalsSchema = z.object({
  tenantId: z.string(),
  accountId: z.string(),
  name: z.string(),
  renewalAt: isoDate.nullable(),
  ownerId: z.string().nullable(),
  usage: z.object({
    previousAdoption: z.number().min(0).max(1).nullable(),
    currentAdoption: z.number().min(0).max(1).nullable(),
  }),
  support: z.object({ urgentOpenTickets: z.number().int().nonnegative().nullable() }),
  billing: z.object({
    standing: z.enum(['current', 'past_due', 'delinquent', 'unknown']).nullable(),
    daysPastDue: z.number().int().nonnegative().nullable(),
  }),
  crm: z.object({ sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']).nullable() }),
  unavailable: z.array(signalName).default([]),
});
export const riskSchema = z.object({
  category: signalName,
  severity: z.enum(['medium', 'high', 'critical']),
  title: z.string(),
  evidence: z.string(),
});
export const actionSchema = z.object({
  title: z.string(),
  owner: z.enum(['csm', 'support', 'billing', 'product']),
  dueAt: isoDate,
});
export const reviewSchema = z.object({
  runId: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  createdAt: isoDate,
  expiresAt: isoDate,
  sourceHash: z.string(),
  artifactHash: z.string(),
  outcome: z.enum(['no_action', 'awaiting_approval', 'rejected', 'written',
    'insufficient_data', 'stale_approval']),
  score: z.number().int().min(0).max(100).nullable(),
  summary: z.string(),
  risks: z.array(riskSchema),
  actions: z.array(actionSchema),
  outreach: z
    .object({ subject: z.string(), body: z.string(), draftOnly: z.literal(true) })
    .nullable(),
  writeId: z.string().nullable(),
  taskIds: z.array(z.string()),
  metrics: z.object({
    latencyMs: z.number().nonnegative(),
    acceptedRecommendations: z.number().int().nonnegative(),
    outreachApproved: z.boolean(),
    hasHumanFeedback: z.boolean(),
    scoreDelta: z.number().nullable(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
});
export const approvalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  approverId: z.string().min(1),
  feedback: z.string().max(2000).optional(),
});
export type AccountSignals = z.infer<typeof accountSignalsSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Risk = z.infer<typeof riskSchema>;
export const outreachSchema = reviewSchema.shape.outreach.unwrap();
