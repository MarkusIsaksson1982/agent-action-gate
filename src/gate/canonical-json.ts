// Canonical JSON: object keys sorted recursively, so the same tool call always hashes to the same idempotency key
// and an audit log entry always hashes to the same value, regardless of property insertion order.
import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v === undefined ? null : v)).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
