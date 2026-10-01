/**
 * Canonical JSON serialization for deterministic hashing and signatures.
 * Recursively sorts all object keys in lexicographical order.
 */

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const result: Record<string, unknown> = {};

  for (const key of sortedKeys) {
    const val = record[key];
    if (val !== undefined) {
      result[key] = canonicalize(val);
    }
  }

  return result;
}

export function serializeCanonical(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
