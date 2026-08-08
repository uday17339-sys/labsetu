import { randomUUID } from 'node:crypto';
import { hmacSha256 } from '@labsetu/crypto';
import type { InstrumentMessageEnvelope, Heartbeat } from '@labsetu/contracts';

export interface GatewayCredentials {
  apiUrl: string;
  deviceId: string;
  deviceKey: string;
  deviceSecret: string;
}

/**
 * Talks to the LabSetu ingest API.
 *
 * Every request is signed: HMAC-SHA256 over `timestamp.nonce.body` using the
 * device secret, which is never transmitted. A stolen device key alone is
 * therefore not enough to inject a fabricated patient result — the attacker
 * would also need the secret.
 */
export class ApiClient {
  constructor(private readonly creds: GatewayCredentials) {}

  async sendMessage(
    envelope: InstrumentMessageEnvelope,
  ): Promise<{ ok: true; status: 'ACCEPTED' | 'DUPLICATE' } | { ok: false; retryable: boolean; error: string }> {
    return this.post('/v1/ingest/messages', envelope);
  }

  async sendHeartbeat(beat: Heartbeat): Promise<void> {
    await this.post('/v1/ingest/heartbeat', beat);
  }

  static async enrol(
    apiUrl: string,
    enrolmentCode: string,
    gatewayVersion: string,
    hostname: string,
  ): Promise<GatewayCredentials & { deviceCode: string; isShadowMode: boolean }> {
    const res = await fetch(`${apiUrl}/v1/ingest/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrolmentCode, gatewayVersion, hostname }),
    });

    if (!res.ok) {
      throw new Error(`Enrolment failed (${res.status}): ${await res.text()}`);
    }

    const body = (await res.json()) as {
      deviceId: string;
      deviceKey: string;
      deviceSecret: string;
      deviceCode: string;
      isShadowMode: boolean;
    };

    return { apiUrl, ...body };
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<
    | { ok: true; status: 'ACCEPTED' | 'DUPLICATE' }
    | { ok: false; retryable: boolean; error: string }
  > {
    // Signed over the EXACT bytes sent. The API buffers the raw body and
    // verifies against those same bytes — re-serialising a parsed object would
    // change key order and whitespace, and the signature would never match.
    const payload = JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const signature = hmacSha256(this.creds.deviceSecret, `${timestamp}.${nonce}.${payload}`);

    try {
      const res = await fetch(`${this.creds.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-device-id': this.creds.deviceId,
          'x-device-key': this.creds.deviceKey,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-signature': signature,
        },
        body: payload,
      });

      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { status?: string };
        return { ok: true, status: json.status === 'DUPLICATE' ? 'DUPLICATE' : 'ACCEPTED' };
      }

      const text = await res.text();

      // 4xx (except 429) means the server will never accept this message —
      // retrying forever would block the whole queue behind a poison message.
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, retryable, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    } catch (err) {
      // Network-level failure: always retryable. This is the outage the
      // store-and-forward outbox exists for.
      return {
        ok: false,
        retryable: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
