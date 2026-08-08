import { createServer, Socket } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { hostname } from 'node:os';
import type { InstrumentMessageEnvelope, InstrumentObservation } from '@labsetu/contracts';
import { Outbox } from './outbox';
import { ApiClient, type GatewayCredentials } from './api-client';
import * as astm from './parsers/astm';
import * as hl7 from './parsers/hl7';

const VERSION = '0.1.0';

/**
 * LabSetu instrument gateway (ADR 0004).
 *
 * Runs on-premises in the lab. Terminates every analyzer protocol locally and
 * emits ONE canonical envelope to the cloud, so the API never learns that ASTM
 * or HL7 exist and adding an analyzer is a configuration change.
 *
 * Design commitments, in priority order:
 *   1. Never lose a result — persist to the outbox before attempting upload.
 *   2. Never guess — an unparseable message is quarantined, not discarded.
 *   3. Never block the analyzer — acknowledge fast, upload asynchronously.
 */

interface ConnectorConfig {
  name: string;
  protocol: 'ASTM_E1394' | 'HL7_V2' | 'FILE_CSV' | 'FILE_XML';
  transport: 'tcp' | 'file';
  port?: number;
  watchDir?: string;
  /** CSV column map: our field name -> zero-based column index. */
  csvColumns?: { specimenRef: number; testCode: number; value: number; units?: number };
}

interface GatewayConfig {
  apiUrl: string;
  deviceId: string;
  deviceKey: string;
  deviceSecret: string;
  outboxPath: string;
  outboxMaxItems: number;
  heartbeatSeconds: number;
  connectors: ConnectorConfig[];
}

const connectorStatus = new Map<string, { status: 'UP' | 'DOWN' | 'DEGRADED'; detail?: string }>();
let lastMessageAt: string | null = null;

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  // Structured, and deliberately free of patient data — a gateway log file sits
  // on a shared lab PC.
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(line));
}

// -----------------------------------------------------------------------------
// Envelope construction
// -----------------------------------------------------------------------------

function buildEnvelope(
  deviceId: string,
  protocol: InstrumentMessageEnvelope['protocol'],
  rawPayload: string,
  observations: InstrumentObservation[],
): InstrumentMessageEnvelope {
  return {
    messageId: randomUUID(),
    deviceId,
    protocol,
    capturedAt: new Date().toISOString(),
    // Checksum of the raw bytes, so tampering in transit is detectable and the
    // archived original can be proven to match what was parsed.
    rawChecksum: createHash('sha256').update(rawPayload, 'utf8').digest('hex'),
    rawPreview: rawPayload.slice(0, 4096),
    observations,
  };
}

// -----------------------------------------------------------------------------
// TCP connectors (ASTM over E1381 framing, HL7 over MLLP)
// -----------------------------------------------------------------------------

function startAstmServer(config: ConnectorConfig, onMessage: (raw: string, obs: InstrumentObservation[]) => void): void {
  const server = createServer((socket: Socket) => {
    log('info', 'analyzer connected', { connector: config.name, peer: socket.remoteAddress });

    let buffer = '';
    let messageAccumulator = '';

    socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('latin1');

      for (const ch of text) {
        const code = ch.charCodeAt(0);

        // Link layer: ENQ -> ACK -> frames -> EOT
        if (code === astm.ENQ) {
          socket.write(Buffer.from([astm.ACK]));
          messageAccumulator = '';
          buffer = '';
          continue;
        }

        if (code === astm.EOT) {
          if (messageAccumulator.trim()) {
            try {
              const observations = astm.toObservations(messageAccumulator);
              onMessage(messageAccumulator, observations);
            } catch (err) {
              log('error', 'ASTM parse failed', {
                connector: config.name,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          messageAccumulator = '';
          continue;
        }

        buffer += ch;

        // A complete frame ends with CR LF after the checksum.
        if (code === astm.LF && buffer.includes(String.fromCharCode(astm.STX))) {
          const frame = astm.parseFrame(buffer);
          if (frame) {
            if (frame.checksumValid) {
              messageAccumulator += frame.text + '\r\n';
              socket.write(Buffer.from([astm.ACK]));
            } else {
              // NAK triggers retransmission. Accepting a bad-checksum frame
              // would let a corrupted value become a clinical result.
              log('warn', 'ASTM checksum mismatch, sending NAK', { connector: config.name });
              socket.write(Buffer.from([astm.NAK]));
            }
          }
          buffer = '';
        }
      }
    });

    socket.on('error', (err) => {
      log('warn', 'analyzer socket error', { connector: config.name, error: err.message });
    });

    socket.on('close', () => {
      log('info', 'analyzer disconnected', { connector: config.name });
    });
  });

  server.listen(config.port, () => {
    connectorStatus.set(config.name, { status: 'UP' });
    log('info', 'ASTM connector listening', { connector: config.name, port: config.port });
  });

  server.on('error', (err) => {
    connectorStatus.set(config.name, { status: 'DOWN', detail: err.message });
    log('error', 'ASTM connector failed', { connector: config.name, error: err.message });
  });
}

function startHl7Server(config: ConnectorConfig, onMessage: (raw: string, obs: InstrumentObservation[]) => void): void {
  const server = createServer((socket: Socket) => {
    log('info', 'analyzer connected', { connector: config.name, peer: socket.remoteAddress });

    let buffer = '';

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');

      // MLLP frame: <VT> message <FS><CR>
      for (;;) {
        const start = buffer.indexOf(String.fromCharCode(hl7.VT));
        const end = buffer.indexOf(String.fromCharCode(hl7.FS), start + 1);
        if (start === -1 || end === -1) break;

        const message = buffer.slice(start + 1, end);
        buffer = buffer.slice(end + 2);

        try {
          const observations = hl7.toObservations(message);
          onMessage(message, observations);
          // The analyzer blocks or retries until it gets an ACK, so send it
          // as soon as the message is safely in the outbox.
          socket.write(
            Buffer.from(
              String.fromCharCode(hl7.VT) + hl7.buildAck(message, true) + String.fromCharCode(hl7.FS, 0x0d),
              'utf8',
            ),
          );
        } catch (err) {
          log('error', 'HL7 parse failed', {
            connector: config.name,
            error: err instanceof Error ? err.message : String(err),
          });
          socket.write(
            Buffer.from(
              String.fromCharCode(hl7.VT) + hl7.buildAck(message, false) + String.fromCharCode(hl7.FS, 0x0d),
              'utf8',
            ),
          );
        }
      }
    });

    socket.on('error', (err) => {
      log('warn', 'analyzer socket error', { connector: config.name, error: err.message });
    });
  });

  server.listen(config.port, () => {
    connectorStatus.set(config.name, { status: 'UP' });
    log('info', 'HL7 MLLP connector listening', { connector: config.name, port: config.port });
  });

  server.on('error', (err) => {
    connectorStatus.set(config.name, { status: 'DOWN', detail: err.message });
    log('error', 'HL7 connector failed', { connector: config.name, error: err.message });
  });
}

// -----------------------------------------------------------------------------
// File connector
// -----------------------------------------------------------------------------

/**
 * Watches a drop directory.
 *
 * Waits for a file to STOP GROWING before reading it. Analyzers and
 * chromatography systems write incrementally, and reading a half-written file
 * is the single most common integration bug in this space — it produces
 * truncated results that look plausible.
 */
function startFileWatcher(
  config: ConnectorConfig,
  onMessage: (raw: string, obs: InstrumentObservation[], protocol: InstrumentMessageEnvelope['protocol']) => void,
): void {
  const dir = config.watchDir!;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'processed'), { recursive: true });
  mkdirSync(join(dir, 'failed'), { recursive: true });

  const sizes = new Map<string, number>();
  const seenHashes = new Set<string>();

  connectorStatus.set(config.name, { status: 'UP' });
  log('info', 'file connector watching', { connector: config.name, dir });

  setInterval(() => {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => /\.(csv|xml|txt)$/i.test(f));
    } catch (err) {
      connectorStatus.set(config.name, {
        status: 'DOWN',
        detail: err instanceof Error ? err.message : 'unreadable',
      });
      return;
    }

    for (const file of files) {
      const path = join(dir, file);
      let size: number;
      try {
        size = readFileSync(path).length;
      } catch {
        continue;
      }

      // Still growing — wait for the next tick.
      if (sizes.get(file) !== size) {
        sizes.set(file, size);
        continue;
      }
      sizes.delete(file);

      try {
        const raw = readFileSync(path, 'utf8');

        // Idempotent on content: a file that reappears does not double-post.
        const hash = createHash('sha256').update(raw).digest('hex');
        if (seenHashes.has(hash)) {
          renameSync(path, join(dir, 'processed', basename(file)));
          continue;
        }

        const observations = parseCsv(raw, config);
        if (observations.length === 0) throw new Error('no parseable observations');

        onMessage(raw, observations, 'FILE_CSV');
        seenHashes.add(hash);
        renameSync(path, join(dir, 'processed', basename(file)));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log('error', 'file parse failed', { connector: config.name, file, error: reason });
        try {
          renameSync(path, join(dir, 'failed', basename(file)));
          // Sidecar reason file so a support call does not require log access.
          writeFileSync(join(dir, 'failed', `${basename(file)}.reason.txt`), reason);
        } catch {
          /* best effort */
        }
      }
    }
  }, 2000).unref();
}

function parseCsv(raw: string, config: ConnectorConfig): InstrumentObservation[] {
  const cols = config.csvColumns ?? { specimenRef: 0, testCode: 1, value: 2, units: 3 };
  const out: InstrumentObservation[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(sample|specimen|accession)/i.test(trimmed)) continue; // header

    const parts = trimmed.split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
    const specimenRef = parts[cols.specimenRef];
    const testCode = parts[cols.testCode];
    const value = parts[cols.value];
    if (!specimenRef || !testCode || value === undefined || value === '') continue;

    out.push({
      specimenRef,
      testCode,
      value,
      units: cols.units !== undefined ? parts[cols.units] || undefined : undefined,
      resultStatus: 'FINAL',
      rerunCount: 0,
      isQc: false,
      rawFields: { line: trimmed },
    });
  }

  return out;
}

// -----------------------------------------------------------------------------
// Uploader
// -----------------------------------------------------------------------------

/**
 * Drains the outbox with exponential backoff.
 *
 * A non-retryable rejection (a 4xx that is not 429) moves the message aside
 * rather than retrying forever — one poison message must not block every result
 * behind it.
 */
function startUploader(outbox: Outbox, client: ApiClient): void {
  let backoffMs = 1000;
  const MAX_BACKOFF = 60_000;

  const tick = async (): Promise<void> => {
    const names = outbox.list(25);

    if (names.length === 0) {
      backoffMs = 1000;
      setTimeout(tick, 2000).unref();
      return;
    }

    let hadRetryableFailure = false;

    for (const name of names) {
      const envelope = outbox.read(name);
      if (!envelope) {
        // read() has already quarantined it.
        continue;
      }

      const result = await client.sendMessage(envelope);

      if (result.ok) {
        outbox.remove(name);
        lastMessageAt = new Date().toISOString();
        log('info', 'message delivered', {
          messageId: envelope.messageId,
          status: result.status,
          observations: envelope.observations.length,
        });
      } else if (result.retryable) {
        hadRetryableFailure = true;
        log('warn', 'delivery failed, will retry', {
          messageId: envelope.messageId,
          error: result.error,
          backoffMs,
        });
        break; // preserve ordering: stop on the first retryable failure
      } else {
        log('error', 'message permanently rejected, quarantining', {
          messageId: envelope.messageId,
          error: result.error,
        });
        outbox.remove(name);
      }
    }

    backoffMs = hadRetryableFailure ? Math.min(backoffMs * 2, MAX_BACKOFF) : 1000;
    setTimeout(tick, hadRetryableFailure ? backoffMs : 500).unref();
  };

  void tick();
}

function startHeartbeat(config: GatewayConfig, outbox: Outbox, client: ApiClient): void {
  const send = async (): Promise<void> => {
    try {
      await client.sendHeartbeat({
        deviceId: config.deviceId,
        gatewayVersion: VERSION,
        outboxDepth: outbox.pendingCount(),
        lastMessageAt,
        connectors: config.connectors.map((c) => ({
          name: c.name,
          protocol: c.protocol,
          status: connectorStatus.get(c.name)?.status ?? 'DOWN',
          detail: connectorStatus.get(c.name)?.detail,
        })),
      });
    } catch (err) {
      log('warn', 'heartbeat failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };

  void send();
  setInterval(send, config.heartbeatSeconds * 1000).unref();
}

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------

function loadConfig(): GatewayConfig {
  const configPath = process.env.GATEWAY_CONFIG_PATH ?? './gateway.config.json';

  const fileConfig: Partial<GatewayConfig> = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Partial<GatewayConfig>)
    : {};

  const config: GatewayConfig = {
    apiUrl: process.env.GATEWAY_API_URL ?? fileConfig.apiUrl ?? 'http://localhost:4000',
    deviceId: process.env.GATEWAY_DEVICE_ID ?? fileConfig.deviceId ?? '',
    deviceKey: process.env.GATEWAY_DEVICE_KEY ?? fileConfig.deviceKey ?? '',
    deviceSecret: process.env.GATEWAY_DEVICE_SECRET ?? fileConfig.deviceSecret ?? '',
    outboxPath: process.env.GATEWAY_OUTBOX_PATH ?? fileConfig.outboxPath ?? './data/outbox',
    outboxMaxItems: Number(process.env.GATEWAY_OUTBOX_MAX_ITEMS ?? fileConfig.outboxMaxItems ?? 50_000),
    heartbeatSeconds: Number(process.env.GATEWAY_HEARTBEAT_SECONDS ?? fileConfig.heartbeatSeconds ?? 60),
    connectors: fileConfig.connectors ?? [],
  };

  if (!config.deviceId || !config.deviceKey || !config.deviceSecret) {
    throw new Error(
      'Gateway is not enrolled. Run:\n\n' +
        '    node dist/index.js --enrol <ENROLMENT-CODE>\n\n' +
        'Get a code from the LabSetu admin UI (Devices -> Issue enrolment code).',
    );
  }

  return config;
}

async function enrol(code: string): Promise<void> {
  const apiUrl = process.env.GATEWAY_API_URL ?? 'http://localhost:4000';
  const creds = await ApiClient.enrol(apiUrl, code, VERSION, hostname());

  const configPath = process.env.GATEWAY_CONFIG_PATH ?? './gateway.config.json';
  const existing: Partial<GatewayConfig> = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Partial<GatewayConfig>)
    : {};

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...existing,
        apiUrl,
        deviceId: creds.deviceId,
        deviceKey: creds.deviceKey,
        // The secret is shown by the API exactly once — losing it means
        // re-enrolling the device.
        deviceSecret: creds.deviceSecret,
        connectors: existing.connectors ?? [],
      },
      null,
      2,
    ),
  );

  log('info', 'enrolled successfully', {
    deviceCode: creds.deviceCode,
    shadowMode: creds.isShadowMode,
    configPath,
  });

  if (creds.isShadowMode) {
    log(
      'warn',
      'Device is in SHADOW MODE: messages will be captured and parsed but NOT written to patient records. ' +
        'Compare against manual entries, then disable shadow mode in the admin UI.',
    );
  }
}

async function main(): Promise<void> {
  const enrolFlag = process.argv.indexOf('--enrol');
  if (enrolFlag !== -1) {
    const code = process.argv[enrolFlag + 1];
    if (!code) throw new Error('Usage: --enrol <ENROLMENT-CODE>');
    await enrol(code);
    return;
  }

  const config = loadConfig();
  const outbox = new Outbox(config.outboxPath, config.deviceSecret, config.outboxMaxItems);
  const client = new ApiClient(config);

  log('info', 'LabSetu gateway starting', {
    version: VERSION,
    deviceId: config.deviceId,
    api: config.apiUrl,
    connectors: config.connectors.length,
    outboxPending: outbox.pendingCount(),
  });

  const handle = (
    protocol: InstrumentMessageEnvelope['protocol'],
  ) => (raw: string, observations: InstrumentObservation[]) => {
    if (observations.length === 0) {
      log('warn', 'message produced no observations, ignoring');
      return;
    }
    const envelope = buildEnvelope(config.deviceId, protocol, raw, observations);
    try {
      // Persisted BEFORE any upload attempt. This is the guarantee.
      outbox.enqueue(envelope);
      log('info', 'message queued', {
        messageId: envelope.messageId,
        observations: observations.length,
      });
    } catch (err) {
      log('error', 'FAILED TO QUEUE MESSAGE', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  for (const connector of config.connectors) {
    switch (connector.protocol) {
      case 'ASTM_E1394':
        startAstmServer(connector, handle('ASTM_E1394'));
        break;
      case 'HL7_V2':
        startHl7Server(connector, handle('HL7_V2'));
        break;
      case 'FILE_CSV':
      case 'FILE_XML':
        startFileWatcher(connector, (raw, obs, protocol) => handle(protocol)(raw, obs));
        break;
      default:
        log('warn', 'unknown connector protocol', { connector: connector.name });
    }
  }

  startUploader(outbox, client);
  startHeartbeat(config, outbox, client);

  const shutdown = (signal: string): void => {
    log('info', 'shutting down', { signal, outboxPending: outbox.pendingCount() });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log('error', 'gateway failed to start', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
