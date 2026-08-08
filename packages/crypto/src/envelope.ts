import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from 'node:crypto';

/**
 * Envelope encryption for field-level PII (ADR 0005).
 *
 *   KMS master key
 *     └── tenant DEK      (wrapped by master)
 *           └── patient data key (wrapped by tenant DEK)
 *                 └── AES-256-GCM ciphertext per field
 *
 * The per-patient layer exists for one concrete reason: DPDP erasure is
 * implemented by destroying one patient's key, which leaves every other record
 * and the audit chain intact. Row deletion could not achieve that.
 *
 * Ciphertext format (all base64url, dot-separated, version-prefixed):
 *
 *   v1.<iv>.<authTag>.<ciphertext>
 *
 * The version prefix is what makes key-algorithm rotation a background re-wrap
 * rather than a downtime event.
 */

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

export type EncryptedValue = string;

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encrypt(plaintext: string, key: Buffer): EncryptedValue {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64(iv), b64(tag), b64(ct)].join('.');
}

export function decrypt(value: EncryptedValue, key: Buffer): string {
  assertKey(key);
  const parts = value.split('.');
  if (parts.length !== 4) {
    throw new Error('Malformed ciphertext: expected 4 dot-separated parts');
  }
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  if (version !== VERSION) {
    throw new Error(`Unsupported ciphertext version "${version}"`);
  }
  const decipher = createDecipheriv(ALGO, key, unb64(ivB64));
  // GCM authenticates as well as encrypts: a tampered ciphertext throws here
  // rather than returning plausible-looking garbage.
  decipher.setAuthTag(unb64(tagB64));
  return Buffer.concat([decipher.update(unb64(ctB64)), decipher.final()]).toString('utf8');
}

/** Wrapping a key is just encrypting its bytes under the parent key. */
export function wrapKey(dataKey: Buffer, wrappingKey: Buffer): string {
  return encrypt(dataKey.toString('base64'), wrappingKey);
}

export function unwrapKey(wrapped: string, wrappingKey: Buffer): Buffer {
  return Buffer.from(decrypt(wrapped, wrappingKey), 'base64');
}

/**
 * Blind index: keyed HMAC of the normalised value, allowing exact-match lookup
 * without decrypting the column (SECURITY.md §5).
 *
 * Normalisation matters more than it looks: an index built over
 * inconsistently-cased or -spaced input silently fails to match, which presents
 * to the user as "patient not found" rather than as a bug.
 *
 * Substring search is deliberately NOT supported — providing it would require
 * leaking structure about the plaintext.
 */
export function blindIndex(value: string, indexKey: Buffer, domain = 'default'): string {
  const normalised = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHmac('sha256', indexKey)
    .update(`${domain}:${normalised}`)
    .digest('base64url');
}

/**
 * Derives the local master key from configuration. Production uses KMS instead;
 * this path exists so development and self-hosted deployments work without a
 * cloud dependency.
 */
export function masterKeyFromBase64(b64Key: string): Buffer {
  const key = Buffer.from(b64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Master key must be exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`AES-256 requires a ${KEY_BYTES}-byte key, got ${key.length}`);
  }
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');
