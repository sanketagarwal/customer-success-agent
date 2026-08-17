import type {
  AccountMemoryStore,
  ApprovalStore,
  BillingRepository,
  Clock,
  CrmRepository,
  CrmWriteResult,
  CrmWriter,
  CustomerSuccessIntelligence,
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
  type PreparedRun,
  type SourceReadResult,
  type SourceSnapshot,
  type TimeWindow,
} from '../schemas/index.js';
import { artifactHash, idempotencyKey, scopeKey } from '../invariants/index.js';
import { applyFactorStatuses, calculateDrift } from './drift.js';
import {
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
}

function assessmentWindow(asOf: string): TimeWindow {
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

  async collect(tenantId: string, accountId: string, window: TimeWindow): Promise<SourceSnapshot> {
    const query = { tenantId, accountId, window };
    const [usage, support, billing, crm] = await Promise.all([
      safeRead('usage', () => this.dependencies.usage.getUsage(query)),
      safeRead('support', () => this.dependencies.support.getSupportHistory(query)),
      safeRead('billing', () => this.dependencies.billing.getBillingStatus(query)),
      safeRead('crm', () => this.dependencies.crm.getCrmNotes(query)),
    ]);
    return sourceSnapshotSchema.parse({ tenantId, accountId, window, usage, support, billing, crm });
  }

  async prepare(input: PrepareRunInput): Promise<PreparedRun> {
    const asOf = input.asOf ?? this.dependencies.clock.now().toISOString();
    const snapshot = await this.collect(input.tenantId, input.accountId, assessmentWindow(asOf));
    const results = [snapshot.usage, snapshot.support, snapshot.billing, snapshot.crm];

    if (results.some((result) => result.status === 'unavailable')) {
      return preparedRunSchema.parse({
        ...input,
        outcome: 'unknown_retry',
        assessment: null,
        drift: null,
        plan: null,
        outreach: null,
        artifactHash: null,
        message: 'At least one required provider was unavailable; retry the account later.',
      });
    }
    if (results.filter((result) => result.status === 'available').length < 2) {
      return preparedRunSchema.parse({
        ...input,
        outcome: 'insufficient_data',
        assessment: null,
        drift: null,
        plan: null,
        outreach: null,
        artifactHash: null,
        message: 'Fewer than two source categories contain usable records.',
      });
    }

    const previous = await this.dependencies.memory.get(input.tenantId, input.accountId);
    const generated = await this.dependencies.intelligence.assess({ snapshot, previous, asOf });
    let assessment = healthAssessmentSchema.parse({
      ...generated,
      sourceSnapshotHash: artifactHash(snapshot),
    });
    const initialGrounding = checkAssessmentGrounding(assessment, snapshot);
    if (!initialGrounding.grounded) {
      return preparedRunSchema.parse({
        ...input,
        outcome: 'grounding_failed',
        assessment,
        drift: null,
        plan: null,
        outreach: null,
        artifactHash: null,
        message: `Unresolved assessment evidence: ${initialGrounding.unresolved.join(', ')}`,
      });
    }

    const drift = calculateDrift(assessment, previous);
    assessment = healthAssessmentSchema.parse(applyFactorStatuses(assessment, drift));
    await this.saveMemory(previous, assessment, drift, null);

    if (assessment.status === 'healthy') {
      return preparedRunSchema.parse({
        ...input,
        outcome: 'no_action',
        assessment,
        drift,
        plan: null,
        outreach: null,
        artifactHash: null,
        message: 'Account is healthy; no plan or outreach was generated.',
      });
    }

    const plan = accountPlanSchema.parse(
      await this.dependencies.intelligence.plan({ assessment, snapshot, asOf }),
    );
    const planGrounding = checkPlanGrounding(plan, snapshot);
    if (!planGrounding.grounded) {
      return preparedRunSchema.parse({
        ...input,
        outcome: 'grounding_failed',
        assessment,
        drift,
        plan,
        outreach: null,
        artifactHash: null,
        message: `Unresolved plan evidence: ${planGrounding.unresolved.join(', ')}`,
      });
    }

    const outreach = outreachDraftSchema.parse(
      await this.dependencies.intelligence.draftOutreach({ assessment, plan, snapshot, asOf }),
    );
    const outreachGrounding = checkOutreachGrounding(outreach, snapshot);
    if (!outreachGrounding.grounded) {
      return preparedRunSchema.parse({
        ...input,
        outcome: 'grounding_failed',
        assessment,
        drift,
        plan,
        outreach,
        artifactHash: null,
        message: `Unresolved outreach evidence: ${outreachGrounding.unresolved.join(', ')}`,
      });
    }

    await this.saveMemory(previous, assessment, drift, plan);
    const bundleHash = artifactHash({ assessment, plan, outreach });
    await this.dependencies.approvals.saveRequest({
      tenantId: input.tenantId,
      accountId: input.accountId,
      runId: input.runId,
      artifactHash: bundleHash,
      artifactAsOf: assessment.asOf,
      requestedAt: asOf,
      expiresAt: new Date(Date.parse(asOf) + 7 * 86_400_000).toISOString(),
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

  async finalize(prepared: PreparedRun, rawDecision: ApprovalDecision): Promise<FinalizedRun> {
    const decision = approvalDecisionSchema.parse(rawDecision);
    const request = await this.dependencies.approvals.getRequest(prepared.runId);
    if (!request || !prepared.assessment || !prepared.plan || !prepared.outreach || !prepared.artifactHash) {
      return { run: { ...prepared, outcome: 'failed', message: 'Approval artifacts are incomplete.' }, write: null };
    }
    await this.dependencies.approvals.saveDecision(prepared.runId, decision);
    if (decision.decision === 'rejected') {
      return { run: { ...prepared, outcome: 'rejected', message: 'CSM rejected the draft; CRM was not updated.' }, write: null };
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
      return { run: { ...prepared, outcome: 'stale_approval', message: 'Approval is stale, expired, or bound to different artifacts.' }, write: null };
    }

    const freshSnapshot = await this.collect(
      prepared.tenantId,
      prepared.accountId,
      assessmentWindow(prepared.assessment.asOf),
    );
    if (artifactHash(freshSnapshot) !== prepared.assessment.sourceSnapshotHash) {
      return { run: { ...prepared, outcome: 'stale_approval', message: 'Source data changed after assessment; approval is required again.' }, write: null };
    }

    const key = idempotencyKey(
      prepared.tenantId,
      prepared.accountId,
      'customer-success-draft',
      prepared.runId,
    );
    const write = await this.dependencies.crmWriter.writeApprovedDraft({
      tenantId: prepared.tenantId,
      accountId: prepared.accountId,
      runId: prepared.runId,
      idempotencyKey: key,
      assessment: prepared.assessment,
      plan: prepared.plan,
      outreach: prepared.outreach,
    });
    return {
      run: { ...prepared, outcome: 'written', message: write.created ? 'Approved draft written to CRM.' : 'Replay detected; prior CRM write returned.' },
      write,
    };
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
        assessments: [
          ...(previous?.assessments ?? []),
          { assessment, drift, recordedAt: now },
        ].slice(-12),
        lastPlan: plan ?? previous?.lastPlan ?? null,
        updatedAt: now,
      }),
    );
  }
}
