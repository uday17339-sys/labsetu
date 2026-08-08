import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  generateKey,
  wrapKey,
  unwrapKey,
  encrypt,
  decrypt,
  blindIndex,
  masterKeyFromBase64,
} from '@labsetu/crypto';
import { CONFIG, type AppConfig } from '../../config/configuration';

/**
 * Field-level envelope encryption (ADR 0005).
 *
 * Tenant DEKs are cached unwrapped in memory with a short TTL: unwrapping on
 * every field read would be a KMS call per patient row. The TTL bounds how long
 * a key stays resident after a tenant is suspended or a key is rotated.
 */
@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;
  private readonly indexKey: Buffer;
  private readonly dekCache = new Map<string, { key: Buffer; expiresAt: number }>();
  private static readonly DEK_TTL_MS = 5 * 60 * 1000;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    if (config.ENCRYPTION_PROVIDER === 'kms') {
      // Deliberately unimplemented rather than silently falling back to the
      // local key — a silent fallback would mean production data encrypted with
      // a key sitting in an environment variable.
      throw new InternalServerErrorException(
        'KMS encryption provider is not implemented yet. Set ENCRYPTION_PROVIDER=local ' +
          'for development; implement KmsCryptoService before production (docs/SECURITY.md §5).',
      );
    }
    this.masterKey = masterKeyFromBase64(config.ENCRYPTION_MASTER_KEY!);
    this.indexKey = masterKeyFromBase64(config.BLIND_INDEX_KEY);
  }

  /** Creates a tenant DEK, returning it plus its wrapped form for storage. */
  createTenantKey(): { key: Buffer; wrapped: string } {
    const key = generateKey();
    return { key, wrapped: wrapKey(key, this.masterKey) };
  }

  unwrapTenantKey(tenantId: string, wrapped: string): Buffer {
    const cached = this.dekCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.key;

    const key = unwrapKey(wrapped, this.masterKey);
    this.dekCache.set(tenantId, { key, expiresAt: Date.now() + CryptoService.DEK_TTL_MS });
    return key;
  }

  /** Called on tenant suspension or key rotation so the cache cannot outlive it. */
  evictTenantKey(tenantId: string): void {
    this.dekCache.delete(tenantId);
  }

  createSubjectKey(tenantKey: Buffer): { key: Buffer; wrapped: string } {
    const key = generateKey();
    return { key, wrapped: wrapKey(key, tenantKey) };
  }

  unwrapSubjectKey(wrapped: string, tenantKey: Buffer): Buffer {
    return unwrapKey(wrapped, tenantKey);
  }

  encryptField(plaintext: string, subjectKey: Buffer): string {
    return encrypt(plaintext, subjectKey);
  }

  /**
   * Returns null for a record whose key has been crypto-shredded under a DPDP
   * erasure request, rather than throwing. An erased patient must still be
   * listable — the clinical record survives, only the identifiers are gone.
   */
  decryptField(ciphertext: string | null, subjectKey: Buffer | null): string | null {
    if (!ciphertext || !subjectKey) return null;
    try {
      return decrypt(ciphertext, subjectKey);
    } catch {
      return null;
    }
  }

  /**
   * Blind index for exact-match search on an encrypted column.
   * `domain` separates namespaces so a phone number and a government ID with
   * the same digits do not collide.
   */
  index(value: string, domain: string): string {
    return blindIndex(value, this.indexKey, domain);
  }
}
