import { createHash } from 'node:crypto';

import type {
  Clock,
  CrmWriteInput,
  CrmWriteResult,
  CrmWriter,
  IdempotencyStore,
} from '../../ports/index.js';

export interface FixtureCrmNote {
  noteId: string;
  tenantId: string;
  accountId: string;
  runId: string;
  healthStatus: string;
  healthScore: number;
  summary: string;
  planActionIds: string[];
  outreachSubject: string;
  outreachBody: string;
  draftOnly: true;
  createdAt: string;
}

export interface FixtureCrmTask {
  taskId: string;
  tenantId: string;
  accountId: string;
  runId: string;
  actionId: string;
  title: string;
  rationale: string;
  owner: string;
  dueAt: string;
  priority: string;
  status: 'not_started';
}

export interface FixtureCrmSnapshot {
  notes: FixtureCrmNote[];
  tasks: FixtureCrmTask[];
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export class MockCrmWriter implements CrmWriter {
  private readonly notes: FixtureCrmNote[] = [];
  private readonly tasks: FixtureCrmTask[] = [];

  constructor(
    private readonly idempotency: IdempotencyStore,
    private readonly clock: Clock,
  ) {}

  async writeApprovedDraft(input: CrmWriteInput): Promise<CrmWriteResult> {
    const prior = await this.idempotency.get(input.idempotencyKey);
    if (prior) return { ...prior, idempotencyKey: prior.key, created: false };

    const writtenAt = this.clock.now().toISOString();
    const writeId = stableId('fixture-note', input.idempotencyKey);
    this.tasks.push(
      ...input.plan.actions.map((action) => ({
        taskId: stableId('fixture-task', `${input.idempotencyKey}:${action.id}`),
        tenantId: input.tenantId,
        accountId: input.accountId,
        runId: input.runId,
        actionId: action.id,
        title: action.title,
        rationale: action.rationale,
        owner: action.owner,
        dueAt: action.dueAt,
        priority: action.priority,
        status: 'not_started' as const,
      })),
    );
    this.notes.push({
      noteId: writeId,
      tenantId: input.tenantId,
      accountId: input.accountId,
      runId: input.runId,
      healthStatus: input.assessment.status,
      healthScore: input.assessment.score,
      summary: input.assessment.summary,
      planActionIds: input.plan.actions.map((action) => action.id),
      outreachSubject: input.outreach.subject,
      outreachBody: input.outreach.body,
      draftOnly: true,
      createdAt: writtenAt,
    });

    const record = { key: input.idempotencyKey, writeId, writtenAt };
    await this.idempotency.save(record);
    return { ...record, idempotencyKey: record.key, created: true };
  }

  snapshot(): FixtureCrmSnapshot {
    return structuredClone({ notes: this.notes, tasks: this.tasks });
  }
}
