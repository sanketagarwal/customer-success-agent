import { z } from 'zod';

export const timestamp = z.iso.datetime({ offset: true });
export const windowSchema = z.object({ start: timestamp, end: timestamp });
export const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const sourceSchema = z.enum(['usage', 'support', 'billing', 'crm']);

export const evidenceSchema = z.object({
  source: sourceSchema,
  recordId: z.string().min(1),
  field: z.string().min(1),
  value: valueSchema,
});

export const usageSchema = z.object({
  recordId: z.string(),
  timestamp,
  activeUsers: z.number().int().nonnegative(),
  licensedSeats: z.number().int().positive(),
  events: z.number().int().nonnegative(),
  adoptionRate: z.number().min(0).max(1),
});

export const ticketSchema = z.object({
  recordId: z.string(),
  createdAt: timestamp,
  status: z.enum(['open', 'pending', 'resolved', 'closed']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  subject: z.string(),
  satisfactionScore: z.number().min(1).max(5).nullable(),
  resolutionHours: z.number().nonnegative().nullable(),
});

export const billingSchema = z.object({
  tenantId: z.string(),
  accountId: z.string(),
  recordId: z.string(),
  asOf: timestamp,
  standing: z.enum(['current', 'past_due', 'delinquent', 'unknown']),
  renewalAt: timestamp.nullable(),
  daysPastDue: z.number().int().nonnegative(),
  annualValue: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
});

export const noteSchema = z.object({
  recordId: z.string(),
  createdAt: timestamp,
  authorId: z.string().nullable(),
  body: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
});

export const accountSchema = z.object({
  tenantId: z.string(),
  accountId: z.string(),
  name: z.string(),
  renewalAt: timestamp.nullable(),
  ownerId: z.string().nullable(),
});

const available = <T extends z.ZodType>(data: T) => z.object({ status: z.literal('available'), data });
const readResult = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('status', [
    available(data),
    z.object({ status: z.literal('empty') }),
    z.object({
      status: z.literal('unavailable'),
      error: z.union([z.string(), z.object({ provider: z.string(), message: z.string() })]),
    }),
  ]);

export const usageResultSchema = readResult(
  z.object({ tenantId: z.string(), accountId: z.string(), window: windowSchema, points: z.array(usageSchema) }),
);
export const supportResultSchema = readResult(
  z.object({ tenantId: z.string(), accountId: z.string(), window: windowSchema, tickets: z.array(ticketSchema) }),
);
export const billingResultSchema = readResult(billingSchema);
export const notesResultSchema = readResult(
  z.object({ tenantId: z.string(), accountId: z.string(), window: windowSchema, notes: z.array(noteSchema) }),
);

export const snapshotSchema = z.object({
  tenantId: z.string(),
  accountId: z.string(),
  window: windowSchema,
  usage: usageResultSchema,
  support: supportResultSchema,
  billing: billingResultSchema,
  crm: notesResultSchema,
});

export const riskSchema = z.object({
  id: z.string(),
  category: z.enum(['adoption', 'support', 'billing', 'relationship', 'renewal', 'other']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  status: z.enum(['new', 'worsening', 'persistent', 'improving', 'resolved']),
  title: z.string(),
  explanation: z.string(),
  evidence: z.array(evidenceSchema).min(1),
});

export const assessmentSchema = z.object({
  tenantId: z.string(),
  accountId: z.string(),
  asOf: timestamp,
  score: z.number().int().min(0).max(100),
  status: z.enum(['healthy', 'watch', 'at_risk', 'critical']),
  summary: z.string(),
  riskFactors: z.array(riskSchema),
  dataCompleteness: z.number().min(0).max(1),
  sourceHash: z.string(),
});

export const actionSchema = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  owner: z.enum(['csm', 'support', 'billing', 'product', 'customer']),
  dueAt: timestamp,
  priority: z.enum(['low', 'medium', 'high']),
  evidence: z.array(evidenceSchema).min(1),
});

export const planSchema = z.object({
  objective: z.string(),
  actions: z.array(actionSchema),
});

export const outreachSchema = z.object({
  channel: z.enum(['email', 'crm_task']),
  subject: z.string(),
  body: z.string(),
  claims: z.array(z.object({ text: z.string(), evidence: z.array(evidenceSchema).min(1) })),
  draftOnly: z.literal(true),
});

export const driftSchema = z.object({
  previousScore: z.number().nullable(),
  scoreDelta: z.number(),
  direction: z.enum(['baseline', 'improving', 'stable', 'worsening']),
});

export const reviewSchema = z.object({
  assessment: assessmentSchema,
  drift: driftSchema,
  plan: planSchema,
  outreach: outreachSchema,
});

export const generatedReviewSchema = z.object({
  assessment: z.object({
    score: z.number().int().min(0).max(100),
    status: assessmentSchema.shape.status,
    riskFactors: z.array(riskSchema.pick({ id: true, category: true, severity: true, evidence: true })),
    dataCompleteness: z.number().min(0).max(1),
  }),
  plan: z.object({
    actions: z.array(actionSchema.pick({ id: true, owner: true, dueAt: true, priority: true, evidence: true })),
  }),
  outreach: z.object({
    channel: outreachSchema.shape.channel,
    claims: z.array(z.object({ evidence: z.array(evidenceSchema).min(1) })),
    draftOnly: z.literal(true),
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
  tenantId: z.string(),
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
  recordedAt: timestamp,
});

export type Account = z.infer<typeof accountSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export type Billing = z.infer<typeof billingSchema>;
export type CrmWrite = z.infer<typeof crmWriteSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type GeneratedReview = z.infer<typeof generatedReviewSchema>;
export type MonitoringEvent = z.infer<typeof monitoringEventSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type TimeWindow = z.infer<typeof windowSchema>;
export type WorkflowOutput = z.infer<typeof workflowOutputSchema>;
export type ReadResult<T> =
  | { status: 'available'; data: T }
  | { status: 'empty' }
  | { status: 'unavailable'; error: string | { provider: string; message: string } };
export type UsageData = Extract<z.infer<typeof usageResultSchema>, { status: 'available' }>['data'];
export type SupportData = Extract<z.infer<typeof supportResultSchema>, { status: 'available' }>['data'];
export type BillingData = Extract<z.infer<typeof billingResultSchema>, { status: 'available' }>['data'];
export type NotesData = Extract<z.infer<typeof notesResultSchema>, { status: 'available' }>['data'];
