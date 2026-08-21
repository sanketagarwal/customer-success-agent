import { z } from 'zod';

const iso = z.iso.datetime({ offset: true });
const result = <T extends z.ZodType>(data: T) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), data }),
  z.object({ status: z.literal('empty') }),
  z.object({ status: z.literal('unavailable'), error: z.string() }),
]);

export const windowSchema = z.object({ start: iso, end: iso });
export const accountSchema = z.object({
  accountId: z.string(),
  name: z.string(),
});

const usagePoint = z.object({
  recordId: z.string(),
  timestamp: iso,
  activeUsers: z.number().int().nonnegative(),
  adoptionRate: z.number().min(0).max(1),
});
const ticket = z.object({
  recordId: z.string(),
  createdAt: iso,
  status: z.enum(['open', 'pending', 'resolved', 'closed']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  subject: z.string(),
});
const billing = z.object({
  recordId: z.string(),
  asOf: iso,
  standing: z.enum(['current', 'past_due', 'delinquent', 'unknown']),
  renewalAt: iso.nullable(),
  daysPastDue: z.number().int().nonnegative(),
});
const note = z.object({
  recordId: z.string(),
  createdAt: iso,
  body: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
});

export const usageResultSchema = result(z.array(usagePoint));
export const supportResultSchema = result(z.array(ticket));
export const billingResultSchema = result(billing);
export const notesResultSchema = result(z.array(note));
export const snapshotSchema = z.object({
  tenantId: z.string(),
  accountId: z.string(),
  window: windowSchema,
  usage: usageResultSchema,
  support: supportResultSchema,
  billing: billingResultSchema,
  crm: notesResultSchema,
});

const evidenceSchema = z.object({
  source: z.enum(['usage', 'support', 'billing', 'crm']),
  recordId: z.string(),
  field: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
const riskCore = z.object({
  id: z.string(),
  category: z.enum(['adoption', 'support', 'billing', 'relationship', 'renewal', 'other']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  evidence: z.array(evidenceSchema).min(1),
});
const actionCore = z.object({
  id: z.string(),
  owner: z.enum(['csm', 'support', 'billing', 'product', 'customer']),
  dueAt: iso,
  priority: z.enum(['low', 'medium', 'high']),
  evidence: z.array(evidenceSchema).min(1),
});

export const proposalSchema = z.object({
  score: z.number().int().min(0).max(100),
  status: z.enum(['healthy', 'watch', 'at_risk', 'critical']),
  risks: z.array(riskCore),
  actions: z.array(actionCore),
  claims: z.array(z.object({ evidence: z.array(evidenceSchema).min(1) })),
});

const risk = riskCore.extend({ title: z.string(), explanation: z.string() });
const action = actionCore.extend({ title: z.string(), rationale: z.string() });
export const reviewSchema = z.object({
  asOf: iso,
  sourceHash: z.string(),
  assessment: z.object({
    score: proposalSchema.shape.score,
    status: proposalSchema.shape.status,
    summary: z.string(),
    completeness: z.number().min(0).max(1),
    risks: z.array(risk),
  }),
  drift: z.object({
    previousScore: z.number().nullable(),
    scoreDelta: z.number(),
    direction: z.enum(['baseline', 'improving', 'stable', 'worsening']),
  }),
  plan: z.object({ actions: z.array(action) }),
  outreach: z.object({
    subject: z.string(),
    body: z.string(),
    claims: proposalSchema.shape.claims,
  }),
});

export const crmWriteSchema = z.object({
  noteId: z.string(),
  taskIds: z.array(z.string()),
  created: z.boolean(),
});
export const outcomeSchema = z.enum([
  'no_action',
  'awaiting_approval',
  'rejected',
  'written',
  'insufficient_data',
  'unknown_retry',
  'grounding_failed',
  'stale_approval',
]);
export const workflowOutputSchema = z.object({
  runId: z.string(),
  accountId: z.string(),
  outcome: outcomeSchema,
  review: reviewSchema.nullable(),
  crm: crmWriteSchema.nullable(),
  message: z.string(),
});
export const monitoringEventSchema = z.object({
  runId: z.string(),
  accountId: z.string(),
  phase: z.enum(['review', 'approval']),
  outcome: outcomeSchema,
  riskScore: z.number().nullable(),
  scoreDelta: z.number().nullable(),
  recommendations: z.number().int().nonnegative(),
  acceptedRecommendations: z.number().int().nonnegative(),
  outreachApproved: z.boolean(),
  feedback: z.boolean(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  recordedAt: iso,
});

export type Account = z.infer<typeof accountSchema>;
export type CrmWrite = z.infer<typeof crmWriteSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type MonitoringEvent = z.infer<typeof monitoringEventSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type TimeWindow = z.infer<typeof windowSchema>;
export type WorkflowOutput = z.infer<typeof workflowOutputSchema>;
export type ReadResult<T> = { status: 'available'; data: T } | { status: 'empty' } | { status: 'unavailable'; error: string };
export type UsageData = z.infer<typeof usagePoint>[];
export type SupportData = z.infer<typeof ticket>[];
export type BillingData = z.infer<typeof billing>;
export type NotesData = z.infer<typeof note>[];
