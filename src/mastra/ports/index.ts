import type {
  Account,
  AccountMemory,
  AccountPlan,
  ApprovalDecision,
  ApprovalRequest,
  BillingStatus,
  CrmNotes,
  CrmTaskWriteResult,
  CrmWriteInput,
  CrmWriteResult,
  GenerationUsage,
  HealthAssessment,
  MonitoringEvent,
  OutreachDraft,
  SourceReadResult,
  SourceSnapshot,
  SupportHistory,
  TimeWindow,
  UsageSeries,
} from '../schemas/index.js';

export interface AccountQuery {
  tenantId: string;
  accountId: string;
  window: TimeWindow;
}

export interface UsageRepository {
  getUsage(query: AccountQuery): Promise<SourceReadResult<UsageSeries>>;
}

export interface SupportRepository {
  getSupportHistory(query: AccountQuery): Promise<SourceReadResult<SupportHistory>>;
}

export interface BillingRepository {
  getBillingStatus(query: AccountQuery): Promise<SourceReadResult<BillingStatus>>;
}

export interface CrmRepository {
  listAccounts(tenantId: string): Promise<readonly Account[]>;
  getCrmNotes(query: AccountQuery): Promise<SourceReadResult<CrmNotes>>;
}

export interface CrmWriter {
  writeApprovedTasks(input: CrmWriteInput): Promise<CrmTaskWriteResult>;
  writeApprovedNote(input: CrmWriteInput): Promise<CrmWriteResult>;
  writeApprovedDraft(input: CrmWriteInput): Promise<CrmWriteResult>;
}

export interface MonitoringStore {
  recordMonitoringEvent(event: MonitoringEvent): Promise<void>;
  listMonitoringEvents(tenantId?: string): Promise<readonly MonitoringEvent[]>;
}

export interface AccountMemoryStore {
  get(tenantId: string, accountId: string): Promise<AccountMemory | null>;
  put(memory: AccountMemory): Promise<void>;
}

export interface ApprovalStore {
  saveRequest(request: ApprovalRequest): Promise<void>;
  saveDecision(runId: string, decision: ApprovalDecision): Promise<void>;
  getRequest(runId: string): Promise<ApprovalRequest | null>;
  getDecision(runId: string): Promise<ApprovalDecision | null>;
}

export interface IdempotencyRecord {
  key: string;
  writeId: string;
  writtenAt: string;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  save(record: IdempotencyRecord): Promise<void>;
}

export interface CrmWriteIntent {
  key: string;
  status: 'pending' | 'completed';
  writeId: string | null;
  updatedAt: string;
}

export interface CrmWriteIntentStore {
  claim(key: string, attemptedAt: string): Promise<boolean>;
  getIntent(key: string): Promise<CrmWriteIntent | null>;
  completeIntent(key: string, writeId: string, completedAt: string): Promise<void>;
  releaseIntent(key: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface AssessmentInput {
  snapshot: SourceSnapshot;
  previous: AccountMemory | null;
  asOf: string;
}

export interface PlanningInput {
  assessment: HealthAssessment;
  snapshot: SourceSnapshot;
  asOf: string;
}

export interface CustomerSuccessIntelligence {
  assess(input: AssessmentInput): Promise<Omit<HealthAssessment, 'sourceSnapshotHash'>>;
  plan(input: PlanningInput): Promise<AccountPlan>;
  draftOutreach(input: PlanningInput & { plan: AccountPlan }): Promise<OutreachDraft>;
  takeUsage?(tenantId: string, accountId: string): GenerationUsage;
}

export type {
  CrmTaskWriteResult,
  CrmWriteInput,
  CrmWriteResult,
  GenerationUsage,
  MonitoringEvent,
} from '../schemas/index.js';
