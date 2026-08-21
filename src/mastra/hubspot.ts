import { z } from 'zod';

import type { AppConfig } from './config.js';
import type { Connectors, Query } from './connectors.js';
import { accountSchema, crmWriteSchema, notesResultSchema } from './schemas.js';
import type { State } from './state.js';

const object = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  createdAt: z.string().optional(),
  properties: z.record(z.string(), z.string().nullable()).default({}),
});
const page = z.object({
  results: z.array(object),
  paging: z.object({ next: z.object({ after: z.union([z.string(), z.number()]).transform(String) }) }).optional(),
});
const associations = z.object({
  results: z.array(z.object({ toObjectId: z.union([z.string(), z.number()]).transform(String) })),
  paging: z.object({ next: z.object({ after: z.union([z.string(), z.number()]).transform(String) }) }).optional(),
});
type HubSpotObject = z.infer<typeof object>;

const date = (value?: string | null) => {
  if (!value) return null;
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const html = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[character]!);

export class HubSpotConnector implements Pick<Connectors, 'listAccounts' | 'readCrmNotes' | 'writeToCrm'> {
  private associationType?: Promise<number>;

  constructor(
    private readonly config: AppConfig,
    private readonly state: State,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  private assertTenant(tenantId: string) {
    if (tenantId !== this.config.tenantId) throw new Error('HubSpot tenant mismatch');
  }

  private async request(path: string, init?: RequestInit, retries = 2): Promise<unknown> {
    let failure: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.fetcher(new URL(path, 'https://api.hubapi.com'), {
          ...init,
          headers: {
            Authorization: `Bearer ${this.config.hubspotToken}`,
            'Content-Type': 'application/json',
            ...init?.headers,
          },
        });
        if (response.ok) return response.status === 204 ? null : response.json();
        failure = new Error(`HubSpot ${response.status}: ${await response.text()}`);
        if (response.status !== 429 && response.status < 500) throw failure;
      } catch (error) {
        failure = error;
        if (error instanceof Error && /^HubSpot 4(?!29)/.test(error.message)) throw error;
      }
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw failure instanceof Error ? failure : new Error('HubSpot request failed');
  }

  async listAccounts(tenantId: string) {
    this.assertTenant(tenantId);
    const results = [];
    let after: string | undefined;
    do {
      const query = new URLSearchParams({ limit: '100', properties: 'name', ...(after ? { after } : {}) });
      const response = page.parse(await this.request(`/crm/v3/objects/companies?${query}`));
      results.push(...response.results.map(company => accountSchema.parse({
        accountId: company.id,
        name: company.properties.name || `HubSpot company ${company.id}`,
      })));
      after = response.paging?.next.after;
    } while (after);
    return results;
  }

  async readCrmNotes(query: Query) {
    this.assertTenant(query.tenantId);
    try {
      const data = (await this.associated(query.accountId, 'notes', ['hs_timestamp', 'hs_note_body'])).flatMap(note => {
        const createdAt = date(note.properties.hs_timestamp) ?? date(note.createdAt);
        return createdAt && createdAt >= query.window.start && createdAt <= query.window.end ? [{
          recordId: note.id,
          createdAt,
          body: note.properties.hs_note_body ?? '',
          sentiment: 'unknown' as const,
        }] : [];
      });
      return data.length ? notesResultSchema.parse({ status: 'available', data }) : { status: 'empty' as const };
    } catch (error) {
      return { status: 'unavailable' as const, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async writeToCrm(input: Parameters<Connectors['writeToCrm']>[0]) {
    this.assertTenant(input.tenantId);
    const marker = `[customer-success:${input.runId}]`;
    const intent = `hubspot:${input.tenantId}:${input.accountId}:${input.runId}`;
    const [notes, tasks, associationTypeId] = await Promise.all([
      this.associated(input.accountId, 'notes', ['hs_note_body']),
      this.associated(input.accountId, 'tasks', ['hs_task_body']),
      this.taskAssociationType(),
    ]);
    const existingNote = notes.find(note => note.properties.hs_note_body?.includes(marker))?.id;
    const existingTasks = new Map(tasks.flatMap(task => {
      const action = task.properties.hs_task_body?.includes(marker)
        ? task.properties.hs_task_body.match(/\[action:([^\]]+)]/)?.[1]
        : undefined;
      return action ? [[action, task.id] as const] : [];
    }));

    const taskIds: string[] = [];
    for (const action of input.review.plan.actions) {
      taskIds.push((await this.writeOnce(
        `${intent}:task:${action.id}`,
        existingTasks.get(action.id),
        async () => object.parse(await this.request('/crm/v3/objects/tasks', {
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
        }, 0)).id,
        () => this.find(input.accountId, 'tasks', 'hs_task_body', `${marker}[action:${action.id}]`),
      )).id);
    }

    const { assessment, plan, outreach } = input.review;
    const noteBody = [
      '<strong>Customer Success review — internal only</strong>',
      marker,
      `<p>Health: ${assessment.status} (${assessment.score}/100)</p>`,
      `<p>${html(assessment.summary)}</p>`,
      `<ul>${plan.actions.map(action => `<li>${html(action.title)}</li>`).join('')}</ul>`,
      '<strong>Outreach draft — not sent</strong>',
      `<p>${html(outreach.subject)}</p>`,
      `<p>${html(outreach.body)}</p>`,
    ].join('\n');
    const note = await this.writeOnce(
      `${intent}:note`,
      existingNote,
      async () => object.parse(await this.request('/crm/v3/objects/notes', {
        method: 'POST',
        body: JSON.stringify({
          properties: { hs_timestamp: new Date().toISOString(), hs_note_body: noteBody },
          associations: [{
            to: { id: input.accountId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 }],
          }],
        }),
      }, 0)).id,
      () => this.find(input.accountId, 'notes', 'hs_note_body', marker),
    );
    return crmWriteSchema.parse({ noteId: note.id, taskIds, created: note.created });
  }

  private async writeOnce(key: string, existing: string | undefined, create: () => Promise<string>, reconcile: () => Promise<string | undefined>) {
    if (existing) {
      await this.state.completeWrite(key, existing);
      return { id: existing, created: false };
    }
    if (!await this.state.claimWrite(key)) {
      const intent = await this.state.getWrite(key);
      if (intent?.status === 'complete' && intent.remoteId) return { id: intent.remoteId, created: false };
      const recovered = await reconcile();
      if (recovered) {
        await this.state.completeWrite(key, recovered);
        return { id: recovered, created: false };
      }
      throw new Error(`HubSpot write is pending for ${key}`);
    }
    try {
      const id = await create();
      await this.state.completeWrite(key, id);
      return { id, created: true };
    } catch (error) {
      const recovered = await reconcile();
      if (recovered) {
        await this.state.completeWrite(key, recovered);
        return { id: recovered, created: true };
      }
      if (error instanceof Error && /^HubSpot 4/.test(error.message)) await this.state.releaseWrite(key);
      throw error;
    }
  }

  private async find(companyId: string, type: 'notes' | 'tasks', property: string, marker: string) {
    return (await this.associated(companyId, type, [property]))
      .find(value => value.properties[property]?.includes(marker))?.id;
  }

  private async associated(companyId: string, type: 'notes' | 'tasks', properties: string[]) {
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const query = new URLSearchParams({ limit: '500', ...(after ? { after } : {}) });
      const response = associations.parse(await this.request(
        `/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/${type}?${query}`,
      ));
      ids.push(...response.results.map(item => item.toObjectId));
      after = response.paging?.next.after;
    } while (after);
    const results: HubSpotObject[] = [];
    for (let index = 0; index < ids.length; index += 100) {
      const response = page.pick({ results: true }).parse(await this.request(`/crm/v3/objects/${type}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({ properties, inputs: ids.slice(index, index + 100).map(id => ({ id })) }),
      }));
      results.push(...response.results);
    }
    return results;
  }

  private taskAssociationType() {
    return this.associationType ??= this.request('/crm/associations/2026-03/tasks/companies/labels').then(value => {
      const labels = z.object({
        results: z.array(z.object({ typeId: z.number(), category: z.string(), label: z.string().nullable().optional() })),
      }).parse(value).results;
      const match = labels.find(label => label.category === 'HUBSPOT_DEFINED' && label.label == null);
      if (!match) throw new Error('HubSpot task-to-company association was not found');
      return match.typeId;
    });
  }
}
