import { randomUUID } from 'node:crypto';

import type {
  AccountMemoryStore,
  ApprovalStore,
  BillingRepository,
  Clock,
  CrmRepository,
  CrmTaskWriteResult,
  CrmWriteResult,
  CrmWriter,
  CustomerSuccessIntelligence,
  MonitoringStore,
  SupportRepository,
  UsageRepository,
} from '../ports/index.js';
import {
  accountMemorySchema,
  accountPlanSchema,
  approvalDecisionSchema,
  healthAssessmentSchema,
  outreachDraftSchema,
  preparedRunSchema,
  sourceSnapshotSchema,
  type AccountMemory,
  type ApprovalDecision,
  type CrmWriteInput,
  type HealthAssessment,
  type Drift,
  type AccountPlan,
  type OutreachDraft,
  type PreparedRun,
  type SourceReadResult,
  type SourceSnapshot,
  type TimeWindow,
} from '../schemas/index.js';
import { artifactHash, idempotencyKey, scopeKey, sourceSnapshotHash } from '../invariants/index.js';
import { applyFactorStatuses, calculateDrift } from './drift.js';
import {
  canonicalizeAssessmentNarratives,
  canonicalizeOutreachNarratives,
  canonicalizePlanNarratives,
  checkAssessmentGrounding,
  checkOutreachGrounding,
  checkPlanGrounding,
} from './grounding.js';

export interface CustomerSuccessDependencies {
  usage: UsageRepository;
  support: SupportRepository;
  billing: BillingRepository;
  crm: CrmRepository;
  crmWriter: CrmWriter;
  memory: AccountMemoryStore;
  approvals: ApprovalStore;
  intelligence: CustomerSuccessIntelligence;
  monitoring: MonitoringStore;
  clock: Clock;
}

export interface PrepareRunInput {
  runId: string;
  tenantId: string;
  accountId: string;
  asOf?: string;
}

export interface FinalizedRun {
  run: PreparedRun;
  write: CrmWriteResult | null;
  tasks: CrmTaskWriteResult | null;
}

export interface NormalizedPrepareRunInput {
  runId: string;
  tenantId: string;
  accountId: string;
  asOf: string;
}

export interface AssessmentStageResult {
  previous: AccountMemory | null;
  assessment: HealthAssessment | null;
  terminal: PreparedRun | null;
}

export interface RiskStageResult {
  assessment: HealthAssessment;
  drift: Drift;
  terminal: PreparedRun | null;
}

export interface PlanStageResult {
  plan: AccountPlan | null;
  terminal: PreparedRun | null;
}

export interface OutreachStageResult {
  outreach: OutreachDraft | null;
  terminal: PreparedRun | null;
}

export interface ApprovalValidationResult {
  run: PreparedRun;
  writeInput: CrmWriteInput | null;
}

export function assessmentWindow(asOf: string): TimeWindow {
  return {
    start: new Date(Date.parse(asOf) - 28 * 86_400_000).toISOString(),
    end: asOf,
  };
}

function unavailable(provider: string, error: unknown): SourceReadResult<never> {
  return {
    status: 'unavailable',
    error: { provider, message: error instanceof Error ? error.message : String(error) },
  };
}

async function safeRead<T>(provider: string, read: () => Promise<SourceReadResult<T>>) {
  try {
    return await read();
  } catch (error) {
    return unavailable(provider, error);
  }
}

export class CustomerSuccessService {
  constructor(private readonly dependencies: CustomerSuccessDependencies) {}

  now(): string {
    return this.dependencies.clock.now().toISOString();
  }

  normalizePrepareInput(input: PrepareRunInput): NormalizedPrepareRunInput {
    return {
      runId: input.runId,
      tenantId: input.tenantId,
      accountId: input.accountId,
      asOf: input.asOf ?? this.dependencies.clock.now().toISOString(),
    };
  }

  async readUsage(tenantId: string, accountId: string, window: TimeWindow) {
    return safeRead('usage', () => this.dependencies.usage.getUsage({ tenantId, accountId, window }));
  }

  async readSupport(tenantId: string, accountId: string, window: TimeWindow) {
    return safeRead('support', () => this.dependencies.support.getSupportHistory({ tenantId, accountId, window }));
  }

  async readBilling(tenantId: string, accountId: string, window: TimeWindow) {
    return safeRead('billing', () => this.dependencies.billing.getBillingStatus({ tenantId, accountId, window }));
  }

  async readCrm(tenantId: string, accountId: string, window: TimeWindow) {
    return safeRead('crm', () => this.dependencies.crm.getCrmNotes({ tenantId, accountId, window }));
  }

  async collect(tenantId: string, accountId: string, window: TimeWindow): Promise<SourceSnapshot> {
    const [usage, support, billing, crm] = await Promise.all([
      this.readUsage(tenantId, accountId, window),
      this.readSupport(tenantId, accountId, window),
      this.readBilling(tenantId, accountId, window),
      this.readCrm(tenantId, accountId, window),
    ]);
    return sourceSnapshotSchema.parse({ tenantId, accountId, window, usage, support, billing, crm });
  }

  async prepare(input: PrepareRunInput): Promise<PreparedRun> {
    const startedAt = performance.now();
    const normalized = this.normalizePrepareInput(input);
    const result = await this.prepareInternal(normalized);
    await this.recordAssessmentMonitoring(normalized, result, performance.now() - startedAt);
    return result;
  }

  async recordAssessmentMonitoring(
    input: Pick<NormalizedPrepareRunInput, 'runId' | 'tenantId' | 'accountId'>,
    result: PreparedRun,
    latencyMs: number,
  ): Promise<void> {
    const usage = this.dependencies.intelligence.takeUsage?.(input.tenantId, input.accountId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    await this.dependencies.monitoring.recordMonitoringEvent({
      eventId: `${input.runId}:assessment:${randomUUID()}`,
      runId: input.runId,
      tenantId: input.tenantId,
      accountId: input.accountId,
      phase: 'assessment',
      outcome: result.outcome,
      riskScore: result.assessment?.score ?? null,
      scoreDelta: result.drift?.scoreDelta ?? null,
      recommendationCount: result.plan?.actions.length ?? 0,
      acceptedRecommendationCount: 0,
      approvalDecision: null,
      outreachApproved: false,
      hasHumanFeedback: false,
      ...usage,
      latencyMs,
      recordedAt: this.dependencies.clock.now().toISOString(),
    });
  }

  async assessHealth(input: NormalizedPrepareRunInput, snapshot: SourceSnapshot): Promise<AssessmentStageResult> {
    const results = [snapshot.usage, snapshot.support, snapshot.billing, snapshot.crm];

    if (results.some(result => result.status === 'unavailable')) {
      return {
        previous: null,
        assessment: null,
        terminal: preparedRunSchema.parse({
          ...input,
          outcome: 'unknown_retry',
          assessment: null,
          drift: null,
          plan: null,
          outreach: null,
          artifactHash: null,
          message: 'At least one required provider was unavailable; retry the account later.',
        }),
      };
    }
    if (results.filter(result => result.status === 'available').length < 2) {
      return {
        previous: null,
        assessment: null,
        terminal: preparedRunSchema.parse({
          ...input,
          outcome: 'insufficient_data',
          assessment: null,
          drift: null,
          plan: null,
          outreach: null,
          artifactHash: null,
          message: 'Fewer than two source categories contain usable records.',
        }),
      };
    }

    const previous = await this.dependencies.memory.get(input.tenantId, input.accountId);
    const generated = await this.dependencies.intelligence.assess({
      snapshot,
      previous,
      asOf: input.asOf,
    });
    let assessment = canonicalizeAssessmentNarratives(
      healthAssessmentSchema.parse({
        ...generated,
        tenantId: input.tenantId,
        accountId: input.accountId,
        asOf: input.asOf,
        sourceSnapshotHash: sourceSnapshotHash(snapshot),
      }),
    );
    const initialGrounding = checkAssessmentGrounding(assessment, snapshot);
    if (!initialGrounding.grounded) {
      return {
        previous,
        assessment,
        terminal: preparedRunSchema.parse({
          ...input,
          outcome: 'grounding_failed',
          assessment,
          drift: null,
          plan: null,
          outreach: null,
          artifactHash: null,
          message: `Unresolved assessment evidence: ${initialGrounding.unresolved.join(', ')}`,
        }),
      };
    }
    return { previous, assessment, terminal: null };
  }

  async calculateRiskDrift(
    input: NormalizedPrepareRunInput,
    previous: AccountMemory | null,
    rawAssessment: HealthAssessment,
  ): Promise<RiskStageResult> {
    let assessment = rawAssessment;
    const drift = calculateDrift(assessment, previous);
    assessment = healthAssessmentSchema.parse(applyFactorStatuses(assessment, drift));
    await this.saveMemory(previous, assessment, drift, null);

    if (assessment.status === 'healthy') {
      return {
        assessment,
        drift,
        terminal: preparedRunSchema.parse({
          ...input,
          outcome: 'no_action',
          assessment,
          drift,
          plan: null,
          outreach: null,
          artifactHash: null,
          message: 'Account is healthy; no plan or outreach was generated.',
        }),
      };
    }
    return { assessment, drift, terminal: null };
  }

  async createPlan(
    input: NormalizedPrepareRunInput,
    snapshot: SourceSnapshot,
    assessment: HealthAssessment,
    drift: Drift,
  ): Promise<PlanStageResult> {
    const generatedPlan = await this.dependencies.intelligence.plan({
      assessment,
      snapshot,
      asOf: input.asOf,
    });
    const plan = canonicalizePlanNarratives(
      accountPlanSchema.parse({
        ...generatedPlan,
        tenantId: input.tenantId,
        accountId: input.accountId,
        asOf: input.asOf,
      }),
    );
    const planGrounding = checkPlanGrounding(plan, snapshot);
    if (!planGrounding.grounded) {
      return {
        plan,
        terminal: preparedRunSchema.parse({
          ...input,
          outcome: 'grounding_failed',
          assessment,
          drift,
          plan,
          outreach: null,
          artifactHash: null,
          message: `Unresolved plan evidence: ${planGrounding.unresolved.join(', ')}`,
        }),
      };
    }
    return { plan, terminal: null };
  }

  async draftOutreach(
    input: NormalizedPrepareRunInput,
    snapshot: SourceSnapshot,
    assessment: HealthAssessment,
    drift: Drift,
    plan: AccountPlan,
  ): Promise<OutreachStageResult> {
    const generatedOutreach = await this.dependencies.intelligence.draftOutreach({
      assessment,
      plan,
      snapshot,
      asOf: input.asOf,
    });
    const outreach = canonicalizeOutreachNarratives(
      outreachDraftSchema.parse({
        ...generatedOutreach,
        tenantId: input.tenantId,
        accountId: input.accountId,
        asOf: input.asOf,
      }),
    );
    const outreachGrounding = checkOutreachGrounding(outreach, snapshot);
    if (!outreachGrounding.grounded) {
      return {
        outreach,
        terminal: preparedRunSchema.parse({
          ...input,
          outcome: 'grounding_failed',
          assessment,
          drift,
          plan,
          outreach,
          artifactHash: null,
          message: `Unresolved outreach evidence: ${outreachGrounding.unresolved.join(', ')}`,
        }),
      };
    }
    return { outreach, terminal: null };
  }

  async bindApprovalArtifacts(
    input: NormalizedPrepareRunInput,
    previous: AccountMemory | null,
    assessment: HealthAssessment,
    drift: Drift,
    plan: AccountPlan,
    outreach: OutreachDraft,
  ): Promise<PreparedRun> {
    await this.saveMemory(previous, assessment, drift, plan);
    const bundleHash = artifactHash({ assessment, plan, outreach });
    await this.dependencies.approvals.saveRequest({
      tenantId: input.tenantId,
      accountId: input.accountId,
      runId: input.runId,
      artifactHash: bundleHash,
      artifactAsOf: assessment.asOf,
      requestedAt: input.asOf,
      expiresAt: new Date(Date.parse(input.asOf) + 7 * 86_400_000).toISOString(),
    });

    return preparedRunSchema.parse({
      ...input,
      outcome: 'awaiting_approval',
      assessment,
      drift,
      plan,
      outreach,
      artifactHash: bundleHash,
      message: 'Grounded plan and outreach draft are waiting for CSM approval.',
    });
  }

  private async prepareInternal(input: NormalizedPrepareRunInput): Promise<PreparedRun> {
    const snapshot = await this.collect(input.tenantId, input.accountId, assessmentWindow(input.asOf));
    const assessed = await this.assessHealth(input, snapshot);
    if (assessed.terminal) return assessed.terminal;
    if (!assessed.assessment) throw new Error('Assessment stage returned no result');
    const risk = await this.calculateRiskDrift(input, assessed.previous, assessed.assessment);
    if (risk.terminal) return risk.terminal;
    const planned = await this.createPlan(input, snapshot, risk.assessment, risk.drift);
    if (planned.terminal) return planned.terminal;
    if (!planned.plan) throw new Error('Planning stage returned no result');
    const drafted = await this.draftOutreach(input, snapshot, risk.assessment, risk.drift, planned.plan);
    if (drafted.terminal) return drafted.terminal;
    if (!drafted.outreach) throw new Error('Outreach stage returned no result');
    return this.bindApprovalArtifacts(
      input,
      assessed.previous,
      risk.assessment,
      risk.drift,
      planned.plan,
      drafted.outreach,
    );
  }

  async finalize(prepared: PreparedRun, rawDecision: ApprovalDecision): Promise<FinalizedRun> {
    const startedAt = performance.now();
    const decision = approvalDecisionSchema.parse(rawDecision);
    const validation = await this.validateApproval(prepared, decision);
    let tasks: CrmTaskWriteResult | null = null;
    let write: CrmWriteResult | null = null;
    let run = validation.run;
    if (validation.writeInput) {
      tasks = await this.writeApprovedTasks(validation.writeInput);
      write = await this.writeApprovedNote(validation.writeInput);
      run = this.completeApprovedWrite(validation.run, tasks, write);
    }
    await this.recordApprovalMonitoring(prepared, decision, run, performance.now() - startedAt);
    return { run, write, tasks };
  }

  async recordApprovalMonitoring(
    prepared: PreparedRun,
    decision: ApprovalDecision,
    run: PreparedRun,
    latencyMs: number,
  ): Promise<void> {
    await this.dependencies.monitoring.recordMonitoringEvent({
      eventId: `${prepared.runId}:approval:${randomUUID()}`,
      runId: prepared.runId,
      tenantId: prepared.tenantId,
      accountId: prepared.accountId,
      phase: 'approval',
      outcome: run.outcome,
      riskScore: prepared.assessment?.score ?? null,
      scoreDelta: prepared.drift?.scoreDelta ?? null,
      recommendationCount: prepared.plan?.actions.length ?? 0,
      acceptedRecommendationCount: run.outcome === 'written' ? (prepared.plan?.actions.length ?? 0) : 0,
      approvalDecision: decision.decision,
      outreachApproved: run.outcome === 'written',
      hasHumanFeedback: Boolean(decision.feedback?.trim()),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      latencyMs,
      recordedAt: this.dependencies.clock.now().toISOString(),
    });
  }

  async validateApproval(prepared: PreparedRun, rawDecision: ApprovalDecision): Promise<ApprovalValidationResult> {
    const decision = approvalDecisionSchema.parse(rawDecision);
    const request = await this.dependencies.approvals.getRequest(prepared.runId);
    if (!request || !prepared.assessment || !prepared.plan || !prepared.outreach || !prepared.artifactHash) {
      return {
        run: { ...prepared, outcome: 'failed', message: 'Approval artifacts are incomplete.' },
        writeInput: null,
      };
    }
    await this.dependencies.approvals.saveDecision(prepared.runId, decision);
    if (decision.decision === 'rejected') {
      return {
        run: {
          ...prepared,
          outcome: 'rejected',
          message: 'CSM rejected the draft; CRM was not updated.',
        },
        writeInput: null,
      };
    }

    const now = this.dependencies.clock.now().toISOString();
    const validBinding =
      decision.boundToHash === prepared.artifactHash &&
      decision.boundToHash === request.artifactHash &&
      decision.boundToAsOf === prepared.assessment.asOf &&
      decision.boundToAsOf === request.artifactAsOf &&
      Date.parse(decision.decidedAt) >= Date.parse(request.requestedAt) &&
      Date.parse(decision.decidedAt) <= Date.parse(now) &&
      Date.parse(decision.decidedAt) <= Date.parse(decision.expiresAt) &&
      Date.parse(now) <= Date.parse(decision.expiresAt) &&
      Date.parse(decision.expiresAt) <= Date.parse(request.expiresAt);
    if (!validBinding) {
      return {
        run: {
          ...prepared,
          outcome: 'stale_approval',
          message: 'Approval is stale, expired, or bound to different artifacts.',
        },
        writeInput: null,
      };
    }

    const freshSnapshot = await this.collect(prepared.tenantId, prepared.accountId, {
      start: assessmentWindow(prepared.assessment.asOf).start,
      end: now,
    });
    const freshResults = [freshSnapshot.usage, freshSnapshot.support, freshSnapshot.billing, freshSnapshot.crm];
    if (freshResults.some(result => result.status === 'unavailable')) {
      return {
        run: {
          ...prepared,
          outcome: 'unknown_retry',
          message: 'A source was unavailable during approval freshness validation.',
        },
        writeInput: null,
      };
    }
    if (sourceSnapshotHash(freshSnapshot) !== prepared.assessment.sourceSnapshotHash) {
      return {
        run: {
          ...prepared,
          outcome: 'stale_approval',
          message: 'Source data changed after assessment; approval is required again.',
        },
        writeInput: null,
      };
    }

    const key = idempotencyKey(prepared.tenantId, prepared.accountId, 'customer-success-draft', prepared.runId);
    return {
      run: prepared,
      writeInput: {
        tenantId: prepared.tenantId,
        accountId: prepared.accountId,
        runId: prepared.runId,
        idempotencyKey: key,
        assessment: prepared.assessment,
        plan: prepared.plan,
        outreach: prepared.outreach,
      },
    };
  }

  writeApprovedTasks(input: CrmWriteInput): Promise<CrmTaskWriteResult> {
    return this.dependencies.crmWriter.writeApprovedTasks(input);
  }

  writeApprovedNote(input: CrmWriteInput): Promise<CrmWriteResult> {
    return this.dependencies.crmWriter.writeApprovedNote(input);
  }

  completeApprovedWrite(prepared: PreparedRun, tasks: CrmTaskWriteResult, note: CrmWriteResult): PreparedRun {
    const taskSummary = `${tasks.createdCount} follow-up task(s) created and ${tasks.existingCount} reused`;
    return preparedRunSchema.parse({
      ...prepared,
      outcome: 'written',
      message: note.created
        ? `Approved internal CRM note written; ${taskSummary}.`
        : `Replay detected; prior CRM note returned and ${taskSummary}.`,
    });
  }

  private async saveMemory(
    previous: AccountMemory | null,
    assessment: NonNullable<PreparedRun['assessment']>,
    drift: NonNullable<PreparedRun['drift']>,
    plan: PreparedRun['plan'],
  ): Promise<void> {
    const now = this.dependencies.clock.now().toISOString();
    await this.dependencies.memory.put(
      accountMemorySchema.parse({
        scopeKey: scopeKey(assessment.tenantId, assessment.accountId),
        tenantId: assessment.tenantId,
        accountId: assessment.accountId,
        version: (previous?.version ?? 0) + 1,
        assessments: [...(previous?.assessments ?? []), { assessment, drift, recordedAt: now }].slice(-12),
        lastPlan: plan ?? previous?.lastPlan ?? null,
        updatedAt: now,
      }),
    );
  }
}
