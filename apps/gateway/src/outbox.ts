import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { InstrumentMessageEnvelope } from '@labsetu/contracts';

/**
 * Durable store-and-forward queue.
 *
 * The single most valuable property of the gateway: a lab's internet outage
 * never loses a result. Messages are written to disk BEFORE any upload is
 * attempted, and only removed once the server has acknowledged them.
 *
 * Sized for ~72 hours of a busy lab's output — long enough to cover a weekend
 * outage without anyone on site.
 *
 * The buffer holds patient results, so it is encrypted at rest with a key
 * derived from the device secret. A stolen gateway disk should not be a
 * disclosure of every result that passed through it.
 *
 * One file per message rather than a database: it is trivially inspectable
 * during a support call, survives a power cut mid-write (partial files fail to
 * decrypt and are quarantined rather than corrupting a shared file), and needs
 * no native dependency on a lab's Windows machine.
 */
export class Outbox {
  private readonly dir: string;
  private readonly key: Buffer;
  private readonly maxItems: number;

  constructor(dir: string, deviceSecret: string, maxItems = 50_000) {
    this.dir = dir;
    this.maxItems = maxItems;
    // Deterministic derivation so the queue survives a gateway restart.
    this.key = scryptSync(deviceSecret, 'labsetu-outbox-v1', 32);
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(join(this.dir, 'quarantine'), { recursive: true });
  }

  /** Persists before any network attempt. Returns the queue filename. */
  enqueue(envelope: InstrumentMessageEnvelope): string {
    const pending = this.pendingCount();
    if (pending >= this.maxItems) {
      // Refuse rather than silently dropping. An operator seeing "outbox full"
      // can act; a silently discarded result cannot be recovered.
      throw new Error(
        `Outbox is full (${pending}/${this.maxItems}). The API has been unreachable for too long — ` +
          `check connectivity before more results are lost.`,
      );
    }

    // Sortable filename so replay preserves capture order.
    const name = `${Date.now()}-${randomUUID()}.msg`;
    writeFileSync(join(this.dir, name), this.encrypt(JSON.stringify(envelope)));
    return name;
  }

  /** Oldest-first, so results replay in the order the analyzer produced them. */
  list(limit = 50): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.msg'))
      .sort()
      .slice(0, limit);
  }

  read(name: string): InstrumentMessageEnvelope | null {
    try {
      const raw = readFileSync(join(this.dir, name));
      return JSON.parse(this.decrypt(raw)) as InstrumentMessageEnvelope;
    } catch {
      // Truncated by a power cut, or written under a different key. Quarantine
      // rather than delete: the bytes may still be recoverable by hand, and
      // silently deleting a patient result is never acceptable.
      this.quarantine(name);
      return null;
    }
  }

  /** Called only after the server has acknowledged the message. */
  remove(name: string): void {
    try {
      unlinkSync(join(this.dir, name));
    } catch {
      /* already gone */
    }
  }

  pendingCount(): number {
    return readdirSync(this.dir).filter((f) => f.endsWith('.msg')).length;
  }

  oldestPendingAge(): number | null {
    const files = this.list(1);
    if (files.length === 0) return null;
    return Date.now() - statSync(join(this.dir, files[0]!)).mtimeMs;
  }

  private quarantine(name: string): void {
    try {
      const from = join(this.dir, name);
      writeFileSync(join(this.dir, 'quarantine', name), readFileSync(from));
      unlinkSync(from);
    } catch {
      /* best effort */
    }
  }

  private encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  private decrypt(buf: Buffer): string {
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
