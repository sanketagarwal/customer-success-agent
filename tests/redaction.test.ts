import { SensitiveDataFilter } from '@mastra/observability';
import { describe, expect, it } from 'vitest';

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
});
