import { createHash } from 'node:crypto';

import type { EvidenceRef, SourceSnapshot } from '../schemas/index.js';

export function scopeKey(tenantId: string, accountId: string): string {
  if (!tenantId || !accountId) {
    throw new Error('tenantId and accountId are required');
  }
  return `${tenantId.length}:${tenantId}|${accountId.length}:${accountId}`;
}

export function idempotencyKey(
  tenantId: string,
  accountId: string,
  artifactType: string,
  runOrAsOf: string,
): string {
  return sha256(canonicalJson({ tenantId, accountId, artifactType, runOrAsOf }));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(',')}}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function artifactHash(value: unknown): string {
  return sha256(canonicalJson({ contractVersion: 1, artifact: value }));
}

function getAtPath(record: unknown, fieldPath: string): unknown {
  return fieldPath.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    if (!(segment in current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, record);
}

function withinWindow(timestamp: string, ref: EvidenceRef): boolean {
  const value = Date.parse(timestamp);
  return value >= Date.parse(ref.window.start) && value <= Date.parse(ref.window.end);
}

export function evidenceResolves(ref: EvidenceRef, sources: SourceSnapshot): boolean {
  let records: readonly Record<string, unknown>[];
  if (ref.source === 'usage') {
    if (sources.usage.status !== 'available') return false;
    records = sources.usage.data.points;
  } else if (ref.source === 'support') {
    if (sources.support.status !== 'available') return false;
    records = sources.support.data.tickets;
  } else if (ref.source === 'crm') {
    if (sources.crm.status !== 'available') return false;
    records = sources.crm.data.notes;
  } else if (ref.source === 'billing') {
    if (sources.billing.status !== 'available') return false;
    records = [sources.billing.data];
  } else return false;

  const record = records.find((candidate) => candidate.recordId === ref.recordId);
  if (!record || getAtPath(record, ref.fieldPath) === undefined) return false;

  const timestamp =
    typeof record.timestamp === 'string'
      ? record.timestamp
      : typeof record.createdAt === 'string'
        ? record.createdAt
        : typeof record.asOf === 'string'
          ? record.asOf
          : undefined;
  return timestamp ? withinWindow(timestamp, ref) : true;
}
