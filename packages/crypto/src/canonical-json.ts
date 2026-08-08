/**
 * Deterministic JSON serialisation for audit-chain hashing (ADR 0003).
 *
 * THIS IS A FROZEN INTERFACE. The audit hash chain is computed over this
 * output. Changing the serialisation — even in a way that looks harmless —
 * makes every historical entry fail verification, which is indistinguishable
 * from tampering. If it must ever change, it needs a version marker on the
 * entry and a verifier that handles both.
 *
 * Guarantees:
 *   - object keys sorted lexicographically (by UTF-16 code unit, i.e. default
 *     Array.prototype.sort, which is stable across JS engines)
 *   - no insignificant whitespace
 *   - Date -> ISO-8601 UTC with millisecond precision
 *   - undefined omitted; null preserved (they are different facts)
 *   - BigInt -> decimal string (JSON.stringify throws on BigInt)
 *   - non-finite numbers rejected rather than silently becoming null
 */
export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'string') return JSON.stringify(value);

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(
        `canonicalJson: non-finite number (${String(value)}) cannot be canonicalised`,
      );
    }
    // JSON.stringify already emits the shortest round-trippable form.
    return JSON.stringify(value);
  }

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'bigint') return `"${(value as bigint).toString(10)}"`;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('canonicalJson: invalid Date cannot be canonicalised');
    }
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    // Array order is meaningful and is preserved. undefined becomes null,
    // matching JSON.stringify, because an array cannot have holes in JSON.
    return `[${value.map((v) => (v === undefined ? 'null' : serialise(v))).join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;

    // Prisma Decimal and similar wrappers expose toJSON/toString. Use their
    // string form so 1.50 and 1.5 do not hash differently by accident.
    if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
      return serialise((obj as { toJSON: () => unknown }).toJSON());
    }

    if (Buffer.isBuffer(value)) {
      return JSON.stringify(value.toString('base64'));
    }

    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();

    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialise(obj[k])}`).join(',')}}`;
  }

  if (t === 'undefined') {
    throw new Error('canonicalJson: undefined at the top level is not serialisable');
  }

  throw new Error(`canonicalJson: unsupported type "${t}"`);
}
