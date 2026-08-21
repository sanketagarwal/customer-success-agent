import { z } from 'zod';

import type { CrmWriteInput, CustomerSuccessConnectors, Query } from './connectors.js';
import { accountSchema, crmWriteSchema, notesResultSchema } from './schemas.js';
import type { WriteIntentStore } from './state.js';

const objectSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  createdAt: z.string(),
  properties: z.record(z.string(), z.string().nullable()).default({}),
});
const pageSchema = z.object({
  results: z.array(objectSchema),
  paging: z.object({ next: z.object({ after: z.union([z.string(), z.number()]).transform(String) }) }).optional(),
});
const associationSchema = z.object({
  results: z.array(z.object({ toObjectId: z.union([z.string(), z.number()]).transform(String) })),
  paging: z.object({ next: z.object({ after: z.union([z.string(), z.number()]).transform(String) }) }).optional(),
});

interface Options {
  tenantId: string;
  token: string;
  baseUrl: string;
  renewalProperty: string;
  writes: WriteIntentStore;
  fetch?: typeof globalThis.fetch;
}

const normalizeDate = (value?: string | null) => {
  if (!value) return null;
  const milliseconds = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

export class HubSpotConnector
  implements Pick<CustomerSuccessConnectors, 'listAccounts' | 'readCrmNotes' | 'writeToCrm'>
{
  private readonly fetcher: typeof globalThis.fetch;
  private taskAssociationType?: Promise<number>;

  constructor(private readonly options: Options) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private assertTenant(tenantId: string) {
    if (tenantId !== this.options.tenantId) throw new Error('HubSpot tenant mismatch');
  }

  private async request(path: string, init?: RequestInit, retry = true) {
    let failure: unknown;
    const attempts = retry ? 3 : 1;
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
        if (response.ok) return response.status === 204 ? null : response.json();
        const message = `HubSpot ${response.status}: ${await response.text()}`;
        if (response.status !== 429 && response.status < 500) throw new Error(message);
        failure = new Error(message);
      } catch (error) {
        failure = error;
        if (error instanceof Error && /^HubSpot 4(?!29)/.test(error.message)) throw error;
      }
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw failure instanceof Error ? failure : new Error('HubSpot request failed');
  }

  async listAccounts(tenantId: string) {
    this.assertTenant(tenantId);
    const accounts = [];
    let after: string | undefined;
    do {
      const query = new URLSearchParams({
        limit: '100',
        properties: `name,hubspot_owner_id,${this.options.renewalProperty}`,
      });
      if (after) query.set('after', after);
      const page = pageSchema.parse(await this.request(`/crm/v3/objects/companies?${query}`));
      accounts.push(
        ...page.results.map(company =>
          accountSchema.parse({
            tenantId,
            accountId: company.id,
            name: company.properties.name || `HubSpot company ${company.id}`,
            renewalAt: normalizeDate(company.properties[this.options.renewalProperty]),
            ownerId: company.properties.hubspot_owner_id || null,
          }),
        ),
      );
      after = page.paging?.next.after;
    } while (after);
    return accounts;
  }

  async readCrmNotes(query: Query) {
    this.assertTenant(query.tenantId);
    try {
      const notes = (await this.readAssociated(query.accountId, 'notes', [
        'hs_timestamp',
        'hs_note_body',
        'hubspot_owner_id',
      ])).flatMap(note => {
        const createdAt = normalizeDate(note.properties.hs_timestamp) ?? normalizeDate(note.createdAt);
        if (!createdAt || createdAt < query.window.start || createdAt > query.window.end) return [];
        return [{
          recordId: note.id,
          createdAt,
          authorId: note.properties.hubspot_owner_id ?? null,
          body: note.properties.hs_note_body ?? '',
          sentiment: 'unknown' as const,
        }];
      });
      return notes.length
        ? notesResultSchema.parse({
            status: 'available',
            data: { tenantId: query.tenantId, accountId: query.accountId, window: query.window, notes },
          })
        : { status: 'empty' as const };
    } catch (error) {
      return { status: 'unavailable' as const, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async writeToCrm(input: CrmWriteInput) {
    this.assertTenant(input.tenantId);
    const marker = `[customer-success:${input.runId}]`;
    const intent = `hubspot:${input.tenantId}:${input.accountId}:${input.runId}`;
    const [notes, tasks] = await Promise.all([
      this.readAssociated(input.accountId, 'notes', ['hs_timestamp', 'hs_note_body']),
      this.readAssociated(input.accountId, 'tasks', ['hs_task_body']),
    ]);
    const existingNote = notes.find(note => note.properties.hs_note_body?.includes(marker));
    const existingTasks = new Map(
      tasks.flatMap(task => {
        const body = task.properties.hs_task_body;
        const actionId = body?.includes(marker) ? body.match(/\[action:([^\]]+)]/)?.[1] : undefined;
        return actionId ? [[actionId, task.id] as const] : [];
      }),
    );

    const associationTypeId = await this.getTaskAssociationType();
    const taskIds = [];
    for (const action of input.review.plan.actions) {
      const result = await this.writeOnce(
        `${intent}:task:${action.id}`,
        existingTasks.get(action.id),
        async () => objectSchema.parse(await this.request('/crm/v3/objects/tasks', {
          method: 'POST',
          body: JSON.stringify({
            properties: {
              hs_timestamp: action.dueAt,
              hs_task_subject: action.title,
              hs_task_body: `${marker}[action:${action.id}]\n${action.rationale}`,
              hs_task_status: 'NOT_STARTED',
              hs_task_priority: action.priority.toUpperCase(),
              hs_task_type: 'TODO',
            },
            associations: [{
              to: { id: input.accountId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }],
            }],
          }),
        }, false)).id,
        async () => (await this.readAssociated(input.accountId, 'tasks', ['hs_task_body']))
          .find(task => task.properties.hs_task_body?.includes(`${marker}[action:${action.id}]`))?.id,
      );
      taskIds.push(result.id);
    }

    const { assessment, plan, outreach } = input.review;
    const body = [
      '<strong>Customer Success review — internal only</strong>',
      marker,
      `<p>Health: ${assessment.status} (${assessment.score}/100)</p>`,
      `<p>${escapeHtml(assessment.summary)}</p>`,
      '<strong>Plan</strong>',
      `<ul>${plan.actions.map(action => `<li>${escapeHtml(action.title)}</li>`).join('')}</ul>`,
      '<strong>Outreach draft — not sent</strong>',
      `<p>${escapeHtml(outreach.subject)}</p>`,
      `<p>${escapeHtml(outreach.body)}</p>`,
    ].join('\n');
    const note = await this.writeOnce(
      `${intent}:note`,
      existingNote?.id,
      async () => objectSchema.parse(await this.request('/crm/v3/objects/notes', {
          method: 'POST',
          body: JSON.stringify({
            properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body },
            associations: [{
              to: { id: input.accountId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 }],
            }],
          }),
        }, false)).id,
      async () => (await this.readAssociated(input.accountId, 'notes', ['hs_note_body']))
        .find(value => value.properties.hs_note_body?.includes(marker))?.id,
    );
    return crmWriteSchema.parse({ noteId: note.id, taskIds, created: note.created });
  }

  private async writeOnce(
    key: string,
    existingId: string | undefined,
    create: () => Promise<string>,
    reconcile: () => Promise<string | undefined>,
  ) {
    if (existingId) {
      await this.options.writes.completeWrite(key, existingId);
      return { id: existingId, created: false };
    }
    if (!await this.options.writes.claimWrite(key)) {
      const intent = await this.options.writes.getWrite(key);
      if (intent?.status === 'complete' && intent.remoteId) return { id: intent.remoteId, created: false };
      const recovered = await reconcile();
      if (recovered) {
        await this.options.writes.completeWrite(key, recovered);
        return { id: recovered, created: false };
      }
      throw new Error(`HubSpot write is pending for ${key}`);
    }
    try {
      const id = await create();
      await this.options.writes.completeWrite(key, id);
      return { id, created: true };
    } catch (error) {
      const recovered = await reconcile();
      if (recovered) {
        await this.options.writes.completeWrite(key, recovered);
        return { id: recovered, created: true };
      }
      if (error instanceof Error && /^HubSpot 4/.test(error.message)) {
        await this.options.writes.releaseWrite(key);
      }
      throw error;
    }
  }

  private async readAssociated(companyId: string, type: 'notes' | 'tasks', properties: string[]) {
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const query = new URLSearchParams({ limit: '500' });
      if (after) query.set('after', after);
      const page = associationSchema.parse(
        await this.request(`/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/${type}?${query}`),
      );
      ids.push(...page.results.map(item => item.toObjectId));
      after = page.paging?.next.after;
    } while (after);
    if (!ids.length) return [];
    const objects = [];
    for (let index = 0; index < ids.length; index += 100) {
      const batch = pageSchema.pick({ results: true }).parse(
        await this.request(`/crm/v3/objects/${type}/batch/read`, {
          method: 'POST',
          body: JSON.stringify({ properties, inputs: ids.slice(index, index + 100).map(id => ({ id })) }),
        }),
      );
      objects.push(...batch.results);
    }
    return objects;
  }

  private getTaskAssociationType() {
    this.taskAssociationType ??= this.request('/crm/associations/2026-03/tasks/companies/labels').then(value => {
      const labels = z.object({
        results: z.array(z.object({ typeId: z.number(), category: z.string(), label: z.string().nullable().optional() })),
      }).parse(value).results;
      const match = labels.find(label => label.category === 'HUBSPOT_DEFINED' && label.label == null);
      if (!match) throw new Error('HubSpot task-to-company association was not found');
      return match.typeId;
    });
    return this.taskAssociationType;
  }
}
