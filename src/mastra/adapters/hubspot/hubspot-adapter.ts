import { z } from 'zod';

import { ProviderUnavailableError } from '../../errors/provider-unavailable-error.js';
import type {
  AccountQuery,
  Clock,
  CrmRepository,
  CrmWriteIntentStore,
  CrmWriteInput,
  CrmWriteResult,
  CrmWriter,
} from '../../ports/index.js';
import { type Account, type CrmNotes, type SourceReadResult } from '../../schemas/index.js';

const objectSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  properties: z.record(z.string(), z.string().nullable()).default({}),
});

const pageSchema = z.object({
  results: z.array(objectSchema),
  paging: z.object({ next: z.object({ after: z.string() }) }).optional(),
});

const associationPageSchema = z.object({
  results: z.array(z.object({ toObjectId: z.coerce.string() })),
  paging: z.object({ next: z.object({ after: z.coerce.string() }) }).optional(),
});

export interface HubSpotAdapterOptions {
  tenantId: string;
  token: string;
  baseUrl: string;
  clock: Clock;
  intents: CrmWriteIntentStore;
  fetch?: typeof globalThis.fetch;
  renewalProperty?: string;
}

export class HubSpotAdapter implements CrmRepository, CrmWriter {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly renewalProperty: string;
  private taskCompanyAssociationType?: Promise<number>;
  private readonly writeLocks = new Map<string, Promise<CrmWriteResult>>();

  constructor(private readonly options: HubSpotAdapterOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.renewalProperty = options.renewalProperty ?? 'renewal_date';
  }

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.options.tenantId) {
      throw new Error('HubSpot adapter rejected a mismatched tenant');
    }
  }

  private async request(
    path: string,
    init?: RequestInit,
    options: { retry?: boolean } = {},
  ): Promise<unknown> {
    const attempts = options.retry === false ? 1 : 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetcher(new URL(path, this.options.baseUrl), {
          ...init,
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            'Content-Type': 'application/json',
            ...init?.headers,
          },
        });
        if (response.ok) return response.status === 204 ? null : await response.json();
        const text = await response.text();
        if (response.status !== 429 && response.status < 500) {
          throw new Error(`HubSpot ${response.status}: ${text}`);
        }
        lastError = new Error(`HubSpot ${response.status}: ${text}`);
        if (attempt + 1 < attempts) {
          const retryAfter = Number(response.headers.get('retry-after') ?? 0);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(retryAfter * 1000 || 250 * 2 ** attempt, 2000)),
          );
        }
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.startsWith('HubSpot 4') && !error.message.startsWith('HubSpot 429')) {
          throw error;
        }
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    }
    throw new ProviderUnavailableError('hubspot', 'HubSpot did not recover within the retry budget', {
      cause: lastError,
    });
  }

  async listAccounts(tenantId: string): Promise<readonly Account[]> {
    this.assertTenant(tenantId);
    const accounts: Account[] = [];
    let after: string | undefined;
    do {
      const params = new URLSearchParams({
        limit: '100',
        properties: `name,hubspot_owner_id,${this.renewalProperty}`,
      });
      if (after) params.set('after', after);
      const page = pageSchema.parse(await this.request(`/crm/v3/objects/companies?${params}`));
      accounts.push(
        ...page.results.map((company) => ({
          tenantId,
          accountId: company.id,
          name: company.properties.name || `HubSpot company ${company.id}`,
          renewalAt: normalizeDate(company.properties[this.renewalProperty]),
          ownerId: company.properties.hubspot_owner_id || null,
        })),
      );
      after = page.paging?.next.after;
    } while (after);
    return accounts;
  }

  async getCrmNotes(query: AccountQuery): Promise<SourceReadResult<CrmNotes>> {
    this.assertTenant(query.tenantId);
    try {
      const notes = await this.readCompanyNotes(query.accountId);
      const filtered = notes.flatMap((note) => {
        const occurredAt = normalizeDate(note.properties.hs_timestamp) ?? normalizeDate(note.createdAt);
        if (!occurredAt || Date.parse(occurredAt) < Date.parse(query.window.start) ||
          Date.parse(occurredAt) > Date.parse(query.window.end)) return [];
        return [{ note, occurredAt }];
      });
      if (filtered.length === 0) return { status: 'empty' };
      return {
        status: 'available',
        data: {
          tenantId: query.tenantId,
          accountId: query.accountId,
          window: query.window,
          notes: filtered.map(({ note, occurredAt }) => ({
            recordId: note.id,
            createdAt: occurredAt,
            authorId: note.properties.hubspot_owner_id ?? null,
            body: note.properties.hs_note_body ?? '',
            sentiment: 'unknown',
          })),
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        error: { provider: 'hubspot', message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async writeApprovedDraft(input: CrmWriteInput): Promise<CrmWriteResult> {
    this.assertTenant(input.tenantId);
    const active = this.writeLocks.get(input.idempotencyKey);
    if (active) return active;
    const operation = this.writeApprovedDraftUnlocked(input);
    this.writeLocks.set(input.idempotencyKey, operation);
    try {
      return await operation;
    } finally {
      if (this.writeLocks.get(input.idempotencyKey) === operation) {
        this.writeLocks.delete(input.idempotencyKey);
      }
    }
  }

  private async writeApprovedDraftUnlocked(input: CrmWriteInput): Promise<CrmWriteResult> {
    const marker = `[customer-success-idempotency:${input.idempotencyKey}]`;
    let tasks = await this.readCompanyTasks(input.accountId);
    const associationTypeId = await this.getTaskCompanyAssociationType();
    for (const action of input.plan.actions) {
      const taskMarker = `${marker}[action:${action.id}]`;
      const existingTask = tasks.find((task) => task.properties.hs_task_body?.includes(taskMarker));
      if (existingTask) {
        await this.options.intents.completeIntent(
          taskMarker,
          existingTask.id,
          existingTask.properties.hs_timestamp ?? existingTask.createdAt,
        );
        continue;
      }
      const claimed = await this.options.intents.claim(
        taskMarker,
        this.options.clock.now().toISOString(),
      );
      if (!claimed) {
        const intent = await this.options.intents.getIntent(taskMarker);
        if (intent?.status === 'completed') continue;
        throw new ProviderUnavailableError(
          'hubspot',
          'A durable task write intent is pending; retry after HubSpot associations converge',
        );
      }
      let rawCreatedTask: unknown;
      try {
        rawCreatedTask = await this.request(
          '/crm/v3/objects/tasks',
          {
            method: 'POST',
            body: JSON.stringify({
              properties: {
                hs_timestamp: action.dueAt,
                hs_task_subject: action.title,
                hs_task_body: `${taskMarker}\n${action.rationale}`,
                hs_task_status: 'NOT_STARTED',
                hs_task_priority: action.priority.toUpperCase(),
                hs_task_type: 'TODO',
              },
              associations: [
                {
                  to: { id: input.accountId },
                  types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }],
                },
              ],
            }),
          },
          { retry: false },
        );
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError)) {
          await this.options.intents.releaseIntent(taskMarker);
          throw error;
        }
        if (isRateLimitRejection(error)) {
          await this.options.intents.releaseIntent(taskMarker);
          throw error;
        }
        try {
          tasks = await this.readCompanyTasks(input.accountId);
        } catch (reconciliationError) {
          throw reconciliationError;
        }
        const reconciled = tasks.some((task) =>
          task.properties.hs_task_body?.includes(taskMarker),
        );
        if (!reconciled) throw error;
        const reconciledTask = tasks.find((task) =>
          task.properties.hs_task_body?.includes(taskMarker),
        )!;
        await this.options.intents.completeIntent(
          taskMarker,
          reconciledTask.id,
          reconciledTask.properties.hs_timestamp ?? reconciledTask.createdAt,
        );
        continue;
      }
      const createdTask = objectSchema.parse(rawCreatedTask);
      await this.options.intents.completeIntent(
        taskMarker,
        createdTask.id,
        createdTask.properties.hs_timestamp ?? createdTask.createdAt,
      );
    }

    const existing = (await this.readCompanyNotes(input.accountId)).find((note) =>
      note.properties.hs_note_body?.includes(marker),
    );
    if (existing) {
      const writtenAt = existing.properties.hs_timestamp ?? existing.createdAt;
      await this.options.intents.completeIntent(marker, existing.id, writtenAt);
      return {
        writeId: existing.id,
        idempotencyKey: input.idempotencyKey,
        created: false,
        writtenAt,
      };
    }
    const noteClaimed = await this.options.intents.claim(
      marker,
      this.options.clock.now().toISOString(),
    );
    if (!noteClaimed) {
      const intent = await this.options.intents.getIntent(marker);
      if (intent?.status === 'completed' && intent.writeId) {
        return {
          writeId: intent.writeId,
          idempotencyKey: input.idempotencyKey,
          created: false,
          writtenAt: intent.updatedAt,
        };
      }
      throw new ProviderUnavailableError(
        'hubspot',
        'A durable note write intent is pending; retry after HubSpot associations converge',
      );
    }

    const writtenAt = this.options.clock.now().toISOString();
    const body = [
      '<strong>Customer Success review draft — internal only</strong>',
      marker,
      `<p>Health: ${escapeHtml(input.assessment.status)} (${input.assessment.score}/100)</p>`,
      `<p>${escapeHtml(input.assessment.summary)}</p>`,
      '<strong>Plan</strong>',
      `<ul>${input.plan.actions.map((action) => `<li>${escapeHtml(action.title)}</li>`).join('')}</ul>`,
      '<strong>Outreach draft — not sent</strong>',
      `<p>${escapeHtml(input.outreach.subject)}</p>`,
      `<p>${escapeHtml(input.outreach.body)}</p>`,
    ].join('\n');
    let rawCreatedNote: unknown;
    try {
      rawCreatedNote = await this.request(
        '/crm/v3/objects/notes',
        {
          method: 'POST',
          body: JSON.stringify({
            properties: { hs_timestamp: writtenAt, hs_note_body: body },
            associations: [
              {
                to: { id: input.accountId },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 }],
              },
            ],
          }),
        },
        { retry: false },
      );
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) {
        await this.options.intents.releaseIntent(marker);
        throw error;
      }
      if (isRateLimitRejection(error)) {
        await this.options.intents.releaseIntent(marker);
        throw error;
      }
      let reconciled;
      try {
        reconciled = (await this.readCompanyNotes(input.accountId)).find((note) =>
          note.properties.hs_note_body?.includes(marker),
        );
      } catch (reconciliationError) {
        throw reconciliationError;
      }
      if (!reconciled) throw error;
      await this.options.intents.completeIntent(marker, reconciled.id, writtenAt);
      return {
        writeId: reconciled.id,
        idempotencyKey: input.idempotencyKey,
        created: true,
        writtenAt,
      };
    }
    const created = objectSchema.parse(rawCreatedNote);
    await this.options.intents.completeIntent(marker, created.id, writtenAt);
    return { writeId: created.id, idempotencyKey: input.idempotencyKey, created: true, writtenAt };
  }

  private async readCompanyNotes(companyId: string) {
    return this.readAssociatedObjects(
      companyId,
      'notes',
      ['hs_timestamp', 'hs_note_body', 'hubspot_owner_id'],
    );
  }

  private async readCompanyTasks(companyId: string) {
    return this.readAssociatedObjects(
      companyId,
      'tasks',
      ['hs_timestamp', 'hs_task_body', 'hs_task_subject', 'hs_task_status'],
    );
  }

  private async readAssociatedObjects(
    companyId: string,
    objectType: 'notes' | 'tasks',
    properties: string[],
  ) {
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const params = new URLSearchParams({ limit: '500' });
      if (after) params.set('after', after);
      const page = associationPageSchema.parse(
        await this.request(
          `/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/${objectType}?${params}`,
        ),
      );
      ids.push(...page.results.map((association) => association.toObjectId));
      after = page.paging?.next.after;
    } while (after);
    if (ids.length === 0) return [];
    const objects = [];
    for (const batchIds of chunk(ids, 100)) {
      const batch = z.object({ results: z.array(objectSchema) }).parse(
        await this.request(`/crm/v3/objects/${objectType}/batch/read`, {
          method: 'POST',
          body: JSON.stringify({
            properties,
            inputs: batchIds.map((id) => ({ id })),
          }),
        }),
      );
      objects.push(...batch.results);
    }
    return objects;
  }

  private async getTaskCompanyAssociationType(): Promise<number> {
    this.taskCompanyAssociationType ??= this.request(
      '/crm/associations/2026-03/tasks/companies/labels',
    ).then((value) => {
      const labels = z
        .object({
          results: z.array(
            z.object({
              typeId: z.number(),
              category: z.string(),
              label: z.string().nullable().optional(),
            }),
          ),
        })
        .parse(value).results;
      const primary = labels.find(
        (label) => label.category === 'HUBSPOT_DEFINED' && (label.label === null || label.label === undefined),
      );
      if (!primary) throw new Error('HubSpot task-to-company association type was not found');
      return primary.typeId;
    });
    return this.taskCompanyAssociationType;
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  return Array.from(
    { length: Math.ceil(values.length / size) },
    (_, index) => values.slice(index * size, (index + 1) * size),
  );
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function isRateLimitRejection(error: ProviderUnavailableError): boolean {
  return error.cause instanceof Error && error.cause.message.startsWith('HubSpot 429:');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
