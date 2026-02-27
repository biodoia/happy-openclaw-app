/**
 * OpenClawBackend - WebSocket-based backend for OpenClaw Gateway
 *
 * Unlike other backends that spawn child processes (Claude SDK, Gemini ACP),
 * this backend connects to a running OpenClaw Gateway via WebSocket.
 * It translates between Happy's AgentMessage protocol and OpenClaw's
 * Gateway WebSocket protocol.
 *
 * Architecture:
 *   Happy App <-> OpenClawBackend <-(WebSocket)-> OpenClaw Gateway <-> LLM
 */

import { randomUUID, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir as nodeHomedir } from 'node:os';

/** Resolve home directory, preferring env var over os.resolveHome() */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || nodeHomedir();
}

import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '../agent/core';
import { logger } from '@/ui/logger';

/**
 * Minimal WebSocket interface for OpenClaw Gateway communication.
 * At runtime we use the global WebSocket available in Node.js 22+.
 */
interface OpenClawSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

const WS_OPEN = 1;

function createSocket(url: string): OpenClawSocket {
  return new (globalThis as any).WebSocket(url) as OpenClawSocket;
}

/** OpenClaw Gateway connection configuration */
export interface OpenClawConfig {
  /** Gateway WebSocket URL (default: ws://127.0.0.1:18789/ws) */
  gatewayUrl?: string;
  /** Authentication token */
  token?: string;
  /** Session key for the OpenClaw agent (default: "main") */
  sessionKey?: string;
  /** Working directory context */
  cwd?: string;
  /** Connection timeout in ms (default: 30000) */
  connectTimeoutMs?: number;
  /** Path to device identity file (default: ~/.openclaw/identity/device.json) */
  deviceIdentityPath?: string;
}

/** Device identity for Ed25519 challenge-response auth */
interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Internal message types from the OpenClaw Gateway protocol */
interface GatewayRequest {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface GatewayResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string | number; message: string };
}

interface GatewayEvent {
  type: 'event';
  event: string;
  payload?: Record<string, unknown>;
  seq?: number;
}

type GatewayMessage = GatewayResponse | GatewayEvent;

/** Build the v2 device auth payload that gets signed */
function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
}): string {
  return [
    'v2',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
  ].join('|');
}

/** Extract raw 32-byte Ed25519 public key from PEM and encode as base64url */
function publicKeyRawBase64Url(publicKeyPem: string): string {
  const pubKey = createPublicKey(publicKeyPem);
  const spkiDer = pubKey.export({ type: 'spki', format: 'der' });
  return (spkiDer as Buffer).subarray(12).toString('base64url');
}

/** Load device identity from the OpenClaw identity file */
function loadDeviceIdentity(path?: string): DeviceIdentity | null {
  const identityPath = path || join(resolveHome(), '.openclaw', 'identity', 'device.json');
  try {
    return JSON.parse(readFileSync(identityPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Load auth token from OpenClaw config */
function loadGatewayToken(): string {
  const configPath = join(resolveHome(), '.openclaw', 'openclaw.json');
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    return cfg?.gateway?.auth?.token || '';
  } catch {
    return '';
  }
}



/**
 * OpenClaw Agent Backend
 *
 * Connects to the OpenClaw Gateway and bridges messages to Happy's
 * session protocol. Supports streaming responses, tool calls, and
 * real-time event forwarding.
 *
 * Protocol flow:
 *   1. WebSocket open
 *   2. Gateway sends connect.challenge with nonce
 *   3. Client signs nonce with Ed25519 device key and sends connect request
 *   4. Gateway responds with hello-ok (granting operator.write scope)
 *   5. Client sends chat.send with sessionKey + idempotencyKey
 *   6. Gateway streams agent events (agent, chat) back
 */
export class OpenClawBackend implements AgentBackend {
  private ws: OpenClawSocket | null = null;
  private handlers: AgentMessageHandler[] = [];
  private pendingRequests = new Map<string, {
    resolve: (value: GatewayResponse) => void;
    reject: (reason: Error) => void;
  }>();
  private config: Required<OpenClawConfig>;
  private device: DeviceIdentity | null = null;
  private connectNonce: string | null = null;
  private connected = false;
  private currentSessionId: SessionId | null = null;
  private responseBuffer = '';
  private isResponding = false;

  constructor(config: OpenClawConfig = {}) {
    const autoToken = config.token || loadGatewayToken() || process.env.OPENCLAW_GATEWAY_TOKEN || '';
    this.config = {
      gatewayUrl: config.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789/ws',
      token: autoToken,
      sessionKey: config.sessionKey || 'main',
      cwd: config.cwd || process.cwd(),
      connectTimeoutMs: config.connectTimeoutMs || 30000,
      deviceIdentityPath: config.deviceIdentityPath || '',
    };
    this.device = loadDeviceIdentity(config.deviceIdentityPath);
    logger.debug(`[OpenClaw] Token resolved: ${autoToken ? 'yes (' + autoToken.substring(0, 8) + '...)' : 'none'}`);
    logger.debug(`[OpenClaw] Device identity: ${this.device ? 'loaded' : 'not found'}`);
  }

  /** Connect to the OpenClaw Gateway WebSocket */
  private async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WS_OPEN) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`OpenClaw Gateway connection timeout (${this.config.connectTimeoutMs}ms)`));
      }, this.config.connectTimeoutMs);

      logger.debug(`[OpenClaw] Connecting to ${this.config.gatewayUrl}`);

      this.ws = createSocket(this.config.gatewayUrl);

      this.ws.addEventListener('message', (event: any) => {
        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const msg = JSON.parse(data) as GatewayMessage;

          // Handle connect.challenge → send connect request
          if (msg.type === 'event' && (msg as GatewayEvent).event === 'connect.challenge') {
            const payload = (msg as GatewayEvent).payload || {};
            this.connectNonce = (payload.nonce as string) || '';
            logger.debug('[OpenClaw] Got challenge, sending connect...');
            this.sendConnect();
            return;
          }

          // Handle hello-ok response
          if (msg.type === 'res' && (msg as GatewayResponse).ok &&
              ((msg as GatewayResponse).payload as Record<string, unknown>)?.type === 'hello-ok') {
            clearTimeout(timeout);
            this.connected = true;
            logger.debug('[OpenClaw] Connected and authenticated');
            resolve();
            return;
          }

          // Handle connect rejection
          if (msg.type === 'res' && !(msg as GatewayResponse).ok) {
            const pending = this.pendingRequests.get((msg as GatewayResponse).id);
            if (pending) {
              this.pendingRequests.delete((msg as GatewayResponse).id);
              pending.reject(new Error((msg as GatewayResponse).error?.message || 'RPC error'));
              return;
            }
            // Could be the connect response failing
            clearTimeout(timeout);
            reject(new Error((msg as GatewayResponse).error?.message || 'Connect rejected'));
            return;
          }

          this.handleGatewayMessage(msg);
        } catch (err) {
          logger.warn('[OpenClaw] Failed to parse gateway message:', String(err));
        }
      });

      this.ws.addEventListener('error', (event: any) => {
        clearTimeout(timeout);
        logger.warn('[OpenClaw] WebSocket error:', event.message || 'unknown');
        reject(new Error(event.message || 'WebSocket error'));
      });

      this.ws.addEventListener('close', (event: any) => {
        this.connected = false;
        logger.debug(`[OpenClaw] WebSocket closed: ${event.code} ${event.reason || ''}`);
        this.emit({ type: 'status', status: 'stopped', detail: `Gateway disconnected (${event.code})` });
      });
    });
  }

  /** Send the connect request with device auth (challenge-response) */
  private sendConnect(): void {
    const role = 'operator';
    const scopes = ['operator.read', 'operator.write'];
    const clientId = 'cli';
    const clientMode = 'cli';
    const signedAtMs = Date.now();

    let deviceField: Record<string, unknown> | undefined;

    if (this.device && this.connectNonce) {
      const payload = buildDeviceAuthPayload({
        deviceId: this.device.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: this.config.token || null,
        nonce: this.connectNonce,
      });
      const privKey = createPrivateKey(this.device.privateKeyPem);
      const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privKey).toString('base64url');

      deviceField = {
        id: this.device.deviceId,
        publicKey: publicKeyRawBase64Url(this.device.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce: this.connectNonce,
      };
    }

    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        version: '1.0.0',
        platform: process.platform,
        mode: clientMode,
      },
      role,
      scopes,
      caps: [],
      commands: [],
      permissions: {},
      locale: 'en-US',
      userAgent: 'happy-openclaw/1.0.0',
    };

    if (this.config.token) {
      params.auth = { token: this.config.token };
    }

    if (deviceField) {
      params.device = deviceField;
    }

    const connectReq: GatewayRequest = {
      type: 'req',
      id: randomUUID(),
      method: 'connect',
      params,
    };
    this.sendRaw(connectReq);
  }

  /** Send a raw JSON message to the Gateway */
  private sendRaw(msg: GatewayRequest): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Send an RPC request and wait for the response */
  private async rpc(method: string, params: Record<string, unknown>): Promise<GatewayResponse> {
    const id = randomUUID();
    const req: GatewayRequest = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 60000);

      this.pendingRequests.set(id, {
        resolve: (res) => {
          clearTimeout(timeout);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.sendRaw(req);
    });
  }

  /** Handle incoming Gateway messages */
  private handleGatewayMessage(msg: GatewayMessage): void {
    if (msg.type === 'res') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg);
        } else {
          pending.reject(new Error(msg.error?.message || 'RPC error'));
        }
      }
      return;
    }

    if (msg.type === 'event') {
      this.handleGatewayEvent(msg);
    }
  }

  /** Map Gateway events to Happy AgentMessages */
  private handleGatewayEvent(event: GatewayEvent): void {
    const p = event.payload || {};

    switch (event.event) {
      // Agent streaming events (nested in agent event with data payload)
      case 'agent': {
        const data = (p.data as Record<string, unknown>) || p;
        const stream = (p.stream as string) || '';
        if (stream === 'text' || data.text) {
          const text = (data.text as string) || '';
          if (text) {
            this.responseBuffer += text;
            this.isResponding = true;
            this.emit({ type: 'model-output', textDelta: text, fullText: this.responseBuffer });
          }
        }
        if (data.type === 'done' || data.type === 'turn.end') {
          this.isResponding = false;
          this.emit({ type: 'status', status: 'idle' });
          this.responseBuffer = '';
        }
        if (data.type === 'turn.start') {
          this.responseBuffer = '';
          this.isResponding = true;
          this.emit({ type: 'status', status: 'running' });
        }
        if (data.type === 'tool.start') {
          const toolName = (data.name as string) || 'unknown';
          const callId = (data.id as string) || randomUUID();
          this.emit({
            type: 'tool-call',
            toolName,
            args: (data.input as Record<string, unknown>) || {},
            callId,
          });
        }
        if (data.type === 'tool.end') {
          const toolName = (data.name as string) || 'unknown';
          const callId = (data.id as string) || '';
          this.emit({
            type: 'tool-result',
            toolName,
            result: data.output,
            callId,
          });
        }
        if (data.type === 'error') {
          const detail = (data.message as string) || 'Unknown error';
          this.emit({ type: 'status', status: 'error', detail });
        }
        break;
      }

      // Chat event (may contain text deltas)
      case 'chat': {
        const text = (p.text as string) || (p.delta as string) || '';
        if (text) {
          this.responseBuffer += text;
          this.isResponding = true;
          this.emit({ type: 'model-output', textDelta: text, fullText: this.responseBuffer });
        }
        if (p.type === 'done' || p.type === 'turn.end') {
          this.isResponding = false;
          this.emit({ type: 'status', status: 'idle' });
          this.responseBuffer = '';
        }
        break;
      }

      // Exec approval events
      case 'exec.approval.requested': {
        const id = (p.id as string) || randomUUID();
        const reason = (p.command as string) || (p.reason as string) || '';
        this.emit({ type: 'permission-request', id, reason, payload: p });
        break;
      }

      // Skip noisy periodic events
      case 'health':
      case 'tick':
      case 'presence':
      case 'heartbeat':
        break;

      default:
        this.emit({ type: 'event', name: event.event, payload: event.payload });
        break;
    }
  }

  /** Emit an AgentMessage to all registered handlers */
  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        logger.warn('[OpenClaw] Handler error:', err);
      }
    }
  }

  // ── AgentBackend interface implementation ────────────────────────────

  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    await this.connect();

    this.currentSessionId = randomUUID();
    this.emit({ type: 'status', status: 'starting' });
    this.emit({ type: 'status', status: 'idle' });

    // Send initial prompt if provided
    if (initialPrompt) {
      await this.sendPrompt(this.currentSessionId, initialPrompt);
    }

    return { sessionId: this.currentSessionId };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected to OpenClaw Gateway');
    }

    this.responseBuffer = '';
    this.isResponding = true;
    this.emit({ type: 'status', status: 'running' });

    await this.rpc('chat.send', {
      sessionKey: this.config.sessionKey,
      message: prompt,
      idempotencyKey: randomUUID(),
    });
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    if (!this.connected) return;

    try {
      await this.rpc('chat.abort', {
        sessionKey: this.config.sessionKey,
      });
    } catch {
      logger.debug('[OpenClaw] Cancel request failed (may not be supported)');
    }

    this.isResponding = false;
    this.emit({ type: 'status', status: 'idle' });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const idx = this.handlers.indexOf(handler);
    if (idx >= 0) {
      this.handlers.splice(idx, 1);
    }
  }

  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    if (!this.connected) return;

    try {
      await this.rpc('exec.approval.resolve', {
        id: requestId,
        approved,
      });
    } catch (err) {
      logger.warn('[OpenClaw] Permission response failed:', err);
    }

    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  async waitForResponseComplete(timeoutMs = 120000): Promise<void> {
    const start = Date.now();
    while (this.isResponding && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async dispose(): Promise<void> {
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers = [];
    this.pendingRequests.clear();
    logger.debug('[OpenClaw] Backend disposed');
  }
}
