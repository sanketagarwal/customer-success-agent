import type {
  Account,
  AccountMemory,
  AccountPlan,
  ApprovalDecision,
  ApprovalRequest,
  BillingStatus,
  CrmNotes,
  HealthAssessment,
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

export interface CrmWriteInput {
  tenantId: string;
  accountId: string;
  runId: string;
  idempotencyKey: string;
  assessment: HealthAssessment;
  plan: AccountPlan;
  outreach: OutreachDraft;
}

export interface CrmWriteResult {
  writeId: string;
  idempotencyKey: string;
  created: boolean;
  writtenAt: string;
}

export interface CrmWriter {
  writeApprovedDraft(input: CrmWriteInput): Promise<CrmWriteResult>;
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
}
