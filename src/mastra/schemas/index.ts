import { z } from 'zod';

export const isoTimestampSchema = z.iso.datetime({ offset: true });

export const timeWindowSchema = z
  .object({
    start: isoTimestampSchema,
    end: isoTimestampSchema,
  })
  .refine(({ start, end }) => Date.parse(start) <= Date.parse(end), {
    message: 'window.start must be before or equal to window.end',
  });

export const evidenceSourceSchema = z.enum(['usage', 'support', 'billing', 'crm']);

export const evidenceRefSchema = z.object({
  source: evidenceSourceSchema,
  recordId: z.string().min(1),
  fieldPath: z.string().min(1),
  window: timeWindowSchema,
});

export const evidenceValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const evidenceSchema = z.object({
  ref: evidenceRefSchema,
  metricOrQuote: z.string().min(1),
  value: evidenceValueSchema,
});

export const usagePointSchema = z.object({
  recordId: z.string().min(1),
  timestamp: isoTimestampSchema,
  activeUsers: z.number().int().nonnegative(),
  licensedSeats: z.number().int().positive(),
  events: z.number().int().nonnegative(),
  adoptionRate: z.number().min(0).max(1),
});

export const usageSeriesSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  window: timeWindowSchema,
  points: z.array(usagePointSchema),
});

export const supportTicketSchema = z.object({
  recordId: z.string().min(1),
  createdAt: isoTimestampSchema,
  status: z.enum(['open', 'pending', 'resolved', 'closed']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  subject: z.string().min(1),
  satisfactionScore: z.number().min(1).max(5).nullable(),
  resolutionHours: z.number().nonnegative().nullable(),
});

export const supportHistorySchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  window: timeWindowSchema,
  tickets: z.array(supportTicketSchema),
});

export const billingStatusSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  recordId: z.string().min(1),
  asOf: isoTimestampSchema,
  standing: z.enum(['current', 'past_due', 'delinquent', 'unknown']),
  renewalAt: isoTimestampSchema.nullable(),
  daysPastDue: z.number().int().nonnegative(),
  annualValue: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
});

export const crmNoteSchema = z.object({
  recordId: z.string().min(1),
  createdAt: isoTimestampSchema,
  authorId: z.string().min(1).nullable(),
  body: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
});

export const crmNotesSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  window: timeWindowSchema,
  notes: z.array(crmNoteSchema),
});

export const accountSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  name: z.string().min(1),
  renewalAt: isoTimestampSchema.nullable(),
  ownerId: z.string().min(1).nullable(),
});

export const sourceReadResultSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), data }),
    z.object({ status: z.literal('empty') }),
    z.object({
      status: z.literal('unavailable'),
      error: z.object({ provider: z.string(), message: z.string() }),
    }),
  ]);

export const sourceSnapshotSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  window: timeWindowSchema,
  usage: sourceReadResultSchema(usageSeriesSchema),
  support: sourceReadResultSchema(supportHistorySchema),
  billing: sourceReadResultSchema(billingStatusSchema),
  crm: sourceReadResultSchema(crmNotesSchema),
});

export const riskFactorSchema = z.object({
  id: z.string().min(1),
  category: z.enum(['adoption', 'support', 'billing', 'relationship', 'renewal', 'other']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  status: z.enum(['new', 'worsening', 'persistent', 'improving', 'resolved']),
  title: z.string().min(1),
  explanation: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
});

export const healthAssessmentSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  asOf: isoTimestampSchema,
  score: z.number().int().min(0).max(100),
  status: z.enum(['healthy', 'watch', 'at_risk', 'critical']),
  summary: z.string().min(1),
  riskFactors: z.array(riskFactorSchema),
  dataCompleteness: z.number().min(0).max(1),
  sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const factorChangeSchema = z.object({
  factorId: z.string().min(1),
  status: z.enum(['new', 'worsening', 'persistent', 'improving', 'resolved']),
});

export const driftSchema = z.object({
  baseline: z.boolean(),
  previousAsOf: isoTimestampSchema.nullable(),
  currentAsOf: isoTimestampSchema,
  scoreDelta: z.number(),
  direction: z.enum(['baseline', 'improving', 'stable', 'worsening']),
  factorChanges: z.array(factorChangeSchema),
});

export const planActionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  owner: z.enum(['csm', 'support', 'billing', 'product', 'customer']),
  dueAt: isoTimestampSchema,
  priority: z.enum(['low', 'medium', 'high']),
  evidence: z.array(evidenceSchema).min(1),
});

export const accountPlanSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  asOf: isoTimestampSchema,
  objective: z.string().min(1),
  actions: z.array(planActionSchema).min(1),
});

export const outreachClaimSchema = z.object({
  text: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
});

export const outreachDraftSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  asOf: isoTimestampSchema,
  channel: z.enum(['email', 'crm_task']),
  subject: z.string().min(1),
  body: z.string().min(1),
  claims: z.array(outreachClaimSchema).min(1),
  draftOnly: z.literal(true),
});

export const crmWriteInputSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  runId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  assessment: healthAssessmentSchema,
  plan: accountPlanSchema,
  outreach: outreachDraftSchema,
});

export const crmWriteResultSchema = z.object({
  writeId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  created: z.boolean(),
  writtenAt: isoTimestampSchema,
});

export const crmTaskWriteResultSchema = z.object({
  taskIds: z.array(z.string().min(1)),
  idempotencyKey: z.string().min(1),
  createdCount: z.number().int().nonnegative(),
  existingCount: z.number().int().nonnegative(),
  completedAt: isoTimestampSchema,
});

export const assessmentMemoryEntrySchema = z.object({
  assessment: healthAssessmentSchema,
  drift: driftSchema,
  recordedAt: isoTimestampSchema,
});

export const accountMemorySchema = z.object({
  scopeKey: z.string().min(1),
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  version: z.number().int().positive(),
  assessments: z.array(assessmentMemoryEntrySchema),
  lastPlan: accountPlanSchema.nullable(),
  updatedAt: isoTimestampSchema,
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  approverId: z.string().min(1),
  decidedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  boundToHash: z.string().regex(/^[a-f0-9]{64}$/),
  boundToAsOf: isoTimestampSchema,
  feedback: z.string().max(4000).optional(),
});

export const approvalRequestSchema = z.object({
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  runId: z.string().min(1),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifactAsOf: isoTimestampSchema,
  requestedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
});

export const runOutcomeSchema = z.enum([
  'no_action',
  'awaiting_approval',
  'rejected',
  'written',
  'insufficient_data',
  'unknown_retry',
  'grounding_failed',
  'stale_approval',
  'failed',
]);

export const preparedRunSchema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  outcome: runOutcomeSchema,
  assessment: healthAssessmentSchema.nullable(),
  drift: driftSchema.nullable(),
  plan: accountPlanSchema.nullable(),
  outreach: outreachDraftSchema.nullable(),
  artifactHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  message: z.string(),
});

export const generationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export const monitoringEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  phase: z.enum(['assessment', 'approval']),
  outcome: runOutcomeSchema,
  riskScore: z.number().int().min(0).max(100).nullable(),
  scoreDelta: z.number().nullable(),
  recommendationCount: z.number().int().nonnegative(),
  acceptedRecommendationCount: z.number().int().nonnegative(),
  approvalDecision: z.enum(['approved', 'rejected']).nullable(),
  outreachApproved: z.boolean(),
  hasHumanFeedback: z.boolean(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  recordedAt: isoTimestampSchema,
});

export type TimeWindow = z.infer<typeof timeWindowSchema>;
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type UsageSeries = z.infer<typeof usageSeriesSchema>;
export type SupportHistory = z.infer<typeof supportHistorySchema>;
export type BillingStatus = z.infer<typeof billingStatusSchema>;
export type CrmNotes = z.infer<typeof crmNotesSchema>;
export type Account = z.infer<typeof accountSchema>;
export type SourceReadResult<T> =
  | { status: 'available'; data: T }
  | { status: 'empty' }
  | { status: 'unavailable'; error: { provider: string; message: string } };
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type RiskFactor = z.infer<typeof riskFactorSchema>;
export type HealthAssessment = z.infer<typeof healthAssessmentSchema>;
export type AccountMemory = z.infer<typeof accountMemorySchema>;
export type Drift = z.infer<typeof driftSchema>;
export type AccountPlan = z.infer<typeof accountPlanSchema>;
export type OutreachDraft = z.infer<typeof outreachDraftSchema>;
export type CrmWriteInput = z.infer<typeof crmWriteInputSchema>;
export type CrmWriteResult = z.infer<typeof crmWriteResultSchema>;
export type CrmTaskWriteResult = z.infer<typeof crmTaskWriteResultSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type PreparedRun = z.infer<typeof preparedRunSchema>;
export type GenerationUsage = z.infer<typeof generationUsageSchema>;
export type MonitoringEvent = z.infer<typeof monitoringEventSchema>;
