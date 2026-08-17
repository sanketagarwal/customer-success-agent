import { z } from 'zod';

import { ProviderUnavailableError } from '../../errors/provider-unavailable-error.js';
import type {
  AccountQuery,
  Clock,
  CrmRepository,
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
  associations: z.record(
    z.string(),
    z.object({ results: z.array(z.object({ id: z.string(), type: z.string().optional() })) }),
  ).optional(),
});

const pageSchema = z.object({
  results: z.array(objectSchema),
  paging: z.object({ next: z.object({ after: z.string() }) }).optional(),
});

export interface HubSpotAdapterOptions {
  tenantId: string;
  token: string;
  baseUrl: string;
  clock: Clock;
  fetch?: typeof globalThis.fetch;
  renewalProperty?: string;
}

export class HubSpotAdapter implements CrmRepository, CrmWriter {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly renewalProperty: string;
  private taskCompanyAssociationType?: Promise<number>;
  private readonly writeLocks = new Map<string, Promise<CrmWriteResult>>();
  private readonly uncertainCreates = new Set<string>();

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
      const filtered = notes.filter(
        (note) => Date.parse(note.createdAt) >= Date.parse(query.window.start) &&
          Date.parse(note.createdAt) <= Date.parse(query.window.end),
      );
      if (filtered.length === 0) return { status: 'empty' };
      return {
        status: 'available',
        data: {
          tenantId: query.tenantId,
          accountId: query.accountId,
          window: query.window,
          notes: filtered.map((note) => ({
            recordId: note.id,
            createdAt: note.properties.hs_timestamp ?? note.createdAt,
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
        this.uncertainCreates.delete(taskMarker);
        continue;
      }
      if (this.uncertainCreates.has(taskMarker)) {
        throw new ProviderUnavailableError(
          'hubspot',
          'A prior task create is still ambiguous; retry after HubSpot associations converge',
        );
      }
      try {
        await this.request(
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
        if (!(error instanceof ProviderUnavailableError)) throw error;
        tasks = await this.readCompanyTasks(input.accountId);
        const reconciled = tasks.some((task) =>
          task.properties.hs_task_body?.includes(taskMarker),
        );
        if (!reconciled) {
          this.uncertainCreates.add(taskMarker);
          throw error;
        }
        this.uncertainCreates.delete(taskMarker);
      }
    }

    const existing = (await this.readCompanyNotes(input.accountId)).find((note) =>
      note.properties.hs_note_body?.includes(marker),
    );
    if (existing) {
      this.uncertainCreates.delete(marker);
      return {
        writeId: existing.id,
        idempotencyKey: input.idempotencyKey,
        created: false,
        writtenAt: existing.properties.hs_timestamp ?? existing.createdAt,
      };
    }
    if (this.uncertainCreates.has(marker)) {
      throw new ProviderUnavailableError(
        'hubspot',
        'A prior note create is still ambiguous; retry after HubSpot associations converge',
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
    let created: z.infer<typeof objectSchema>;
    try {
      created = objectSchema.parse(
        await this.request(
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
        ),
      );
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      const reconciled = (await this.readCompanyNotes(input.accountId)).find((note) =>
        note.properties.hs_note_body?.includes(marker),
      );
      if (!reconciled) {
        this.uncertainCreates.add(marker);
        throw error;
      }
      this.uncertainCreates.delete(marker);
      created = reconciled;
    }
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
    const company = objectSchema.parse(
      await this.request(
        `/crm/v3/objects/companies/${encodeURIComponent(companyId)}?associations=${objectType}`,
      ),
    );
    const ids = company.associations?.[objectType]?.results.map((association) => association.id) ?? [];
    if (ids.length === 0) return [];
    const batch = z.object({ results: z.array(objectSchema) }).parse(
      await this.request(`/crm/v3/objects/${objectType}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({
          properties,
          inputs: ids.map((id) => ({ id })),
        }),
      }),
    );
    return batch.results;
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

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
