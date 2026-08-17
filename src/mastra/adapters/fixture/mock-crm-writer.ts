import { randomUUID } from 'node:crypto';

import type { Clock, CrmWriteInput, CrmWriteResult, CrmWriter, IdempotencyStore } from '../../ports/index.js';

export class MockCrmWriter implements CrmWriter {
  constructor(
    private readonly idempotency: IdempotencyStore,
    private readonly clock: Clock,
  ) {}

  async writeApprovedDraft(input: CrmWriteInput): Promise<CrmWriteResult> {
    const prior = await this.idempotency.get(input.idempotencyKey);
    if (prior) return { ...prior, idempotencyKey: prior.key, created: false };

    const record = {
      key: input.idempotencyKey,
      writeId: `fixture-write-${randomUUID()}`,
      writtenAt: this.clock.now().toISOString(),
    };
    await this.idempotency.save(record);
    return { ...record, idempotencyKey: record.key, created: true };
  }
}
