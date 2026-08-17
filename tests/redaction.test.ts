import { SensitiveDataFilter } from '@mastra/observability';
import { describe, expect, it } from 'vitest';

import { assessmentPrompt } from '../src/mastra/adapters/model/mastra-intelligence.js';
import { createTestSystem, fixtureAsOf } from './helpers.js';

describe('observability redaction', () => {
  it('redacts CRM notes, outreach bodies, feedback, and tokens while retaining IDs', () => {
    const filter = new SensitiveDataFilter({
      sensitiveFields: ['token', 'body', 'notes', 'feedback'],
    });
    const span = {
      traceId: 'trace-1',
      spanId: 'span-1',
      input: {
        accountId: 'company-declining',
        token: 'private-token',
        body: 'customer outreach text',
        notes: [{ body: 'private CRM note' }],
        feedback: 'private CSM feedback',
      },
      attributes: {},
      metadata: {},
    } as unknown as Parameters<SensitiveDataFilter['process']>[0];
    const processed = filter.process(span);
    expect(processed.input).toMatchObject({
      accountId: 'company-declining',
      token: '[REDACTED]',
      body: '[REDACTED]',
      notes: [{ body: '[REDACTED]' }],
      feedback: '[REDACTED]',
    });
  });

  it('removes customer free text before constructing serialized model prompts', async () => {
    const { service } = createTestSystem();
    const snapshot = await service.collect('demo-tenant', 'company-declining', {
      start: '2026-07-20T09:00:00.000Z',
      end: fixtureAsOf,
    });
    expect(snapshot.support.status).toBe('available');
    expect(snapshot.crm.status).toBe('available');
    if (snapshot.support.status !== 'available' || snapshot.crm.status !== 'available') return;
    const supportSubject = snapshot.support.data.tickets[0]!.subject;
    const noteBody = snapshot.crm.data.notes[0]!.body;
    const prompt = assessmentPrompt(snapshot);

    expect(prompt).not.toContain(supportSubject);
    expect(prompt).not.toContain(noteBody);
    expect(prompt).toContain('"subject":"[REDACTED]"');
    expect(prompt).toContain('"body":"[REDACTED]"');

    const filter = new SensitiveDataFilter({ sensitiveFields: ['body', 'subject', 'notes'] });
    const processed = filter.process({
      traceId: 'trace-prompt',
      spanId: 'span-prompt',
      input: prompt,
      attributes: {},
      metadata: {},
    } as unknown as Parameters<SensitiveDataFilter['process']>[0]);
    expect(String(processed.input)).not.toContain(supportSubject);
    expect(String(processed.input)).not.toContain(noteBody);
  });
});
