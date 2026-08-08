import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { canonicalJson } from './canonical-json';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Json(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function hmacSha256(key: Buffer | string, input: string | Buffer): string {
  return createHmac('sha256', key).update(input).digest('hex');
}

/**
 * Constant-time comparison. Used for HMAC signatures and token hashes, where a
 * timing side channel would leak the secret one byte at a time.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so the early return does not itself leak
    // length information through timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Human-transcribable code for device enrolment. Excludes 0/O/1/I/L to survive
 * being read aloud over a phone or copied off a screen in a lab.
 */
export function randomEnrolmentCode(groups = 3, groupLength = 4): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let chunk = '';
    const bytes = randomBytes(groupLength);
    for (let i = 0; i < groupLength; i++) {
      chunk += alphabet[bytes[i]! % alphabet.length];
    }
    out.push(chunk);
  }
  return out.join('-');
}

/**
 * The audit chain link (ADR 0003).
 *
 *   hash = SHA256( prevHash ‖ canonicalJson(entry) )
 *
 * The genesis entry uses a fixed, documented seed so a chain's first link is
 * reproducible by anyone verifying it independently.
 */
export const AUDIT_GENESIS_HASH = sha256('labsetu:audit:genesis:v1');

export function auditEntryHash(prevHash: string, entry: unknown): string {
  return sha256(`${prevHash}${canonicalJson(entry)}`);
}
