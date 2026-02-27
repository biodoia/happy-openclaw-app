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

import { randomUUID } from 'node:crypto';

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

const WS_OPEN = 1; // WS_OPEN constant

function createSocket(url: string): OpenClawSocket {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (globalThis as any).WebSocket(url) as OpenClawSocket;
}

import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '../agent/core';
import { logger } from '@/ui/logger';

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
  error?: { code: number; message: string };
}

interface GatewayEvent {
  type: 'event';
  event: string;
  payload?: Record<string, unknown>;
  seq?: number;
}

type GatewayMessage = GatewayResponse | GatewayEvent;

/**
 * OpenClaw Agent Backend
 *
 * Connects to the OpenClaw Gateway and bridges messages to Happy's
 * session protocol. Supports streaming responses, tool calls, and
 * real-time event forwarding.
 */
export class OpenClawBackend implements AgentBackend {
  private ws: OpenClawSocket | null = null;
  private handlers: AgentMessageHandler[] = [];
  private pendingRequests = new Map<string, {
    resolve: (value: GatewayResponse) => void;
    reject: (reason: Error) => void;
  }>();
  private config: Required<OpenClawConfig>;
  private connected = false;
  private currentSessionId: SessionId | null = null;
  private responseBuffer = '';
  private isResponding = false;

  constructor(config: OpenClawConfig = {}) {
    this.config = {
      gatewayUrl: config.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789/ws',
      token: config.token || process.env.OPENCLAW_GATEWAY_TOKEN || '',
      sessionKey: config.sessionKey || 'main',
      cwd: config.cwd || process.cwd(),
      connectTimeoutMs: config.connectTimeoutMs || 30000,
    };
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

      this.ws.addEventListener('open', () => {
        logger.debug('[OpenClaw] WebSocket connected, sending handshake');
        this.sendHandshake();
      });

      this.ws.addEventListener('message', (event: any) => {
        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const msg = JSON.parse(data) as GatewayMessage;
          this.handleGatewayMessage(msg);

          // Resolve connection on hello-ok
          if (msg.type === 'res' && msg.ok && (msg.payload as Record<string, unknown>)?.type === 'hello-ok') {
            clearTimeout(timeout);
            this.connected = true;
            logger.debug('[OpenClaw] Connected and authenticated');
            resolve();
          }
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

  /** Send the initial handshake to authenticate with the Gateway */
  private sendHandshake(): void {
    const connectReq: GatewayRequest = {
      type: 'req',
      id: randomUUID(),
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'happy-openclaw',
          version: '1.0.0',
          platform: process.platform,
          mode: 'operator',
        },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        auth: { token: this.config.token },
      },
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
    switch (event.event) {
      case 'agent.chunk': {
        const text = (event.payload?.text as string) || '';
        this.responseBuffer += text;
        this.isResponding = true;
        this.emit({ type: 'model-output', textDelta: text, fullText: this.responseBuffer });
        break;
      }

      case 'agent.done':
      case 'agent.turn.end': {
        this.isResponding = false;
        this.emit({ type: 'status', status: 'idle' });
        this.responseBuffer = '';
        break;
      }

      case 'agent.turn.start': {
        this.responseBuffer = '';
        this.isResponding = true;
        this.emit({ type: 'status', status: 'running' });
        break;
      }

      case 'agent.tool.start': {
        const toolName = (event.payload?.name as string) || 'unknown';
        const callId = (event.payload?.id as string) || randomUUID();
        this.emit({
          type: 'tool-call',
          toolName,
          args: (event.payload?.input as Record<string, unknown>) || {},
          callId,
        });
        break;
      }

      case 'agent.tool.end': {
        const toolName = (event.payload?.name as string) || 'unknown';
        const callId = (event.payload?.id as string) || '';
        this.emit({
          type: 'tool-result',
          toolName,
          result: event.payload?.output,
          callId,
        });
        break;
      }

      case 'agent.error': {
        const detail = (event.payload?.message as string) || 'Unknown error';
        this.emit({ type: 'status', status: 'error', detail });
        break;
      }

      case 'agent.permission': {
        const id = (event.payload?.id as string) || randomUUID();
        const reason = (event.payload?.reason as string) || '';
        this.emit({
          type: 'permission-request',
          id,
          reason,
          payload: event.payload,
        });
        break;
      }

      default:
        // Forward any unrecognized events as generic events
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

    // Create or join a session on the Gateway
    try {
      await this.rpc('session.join', {
        sessionKey: this.config.sessionKey,
        cwd: this.config.cwd,
      });
    } catch {
      // session.join may not exist on all versions; continue anyway
      logger.debug('[OpenClaw] session.join not available, using default session');
    }

    this.emit({ type: 'status', status: 'idle' });

    // Send initial prompt if provided
    if (initialPrompt) {
      await this.sendPrompt(this.currentSessionId, initialPrompt);
    }

    return { sessionId: this.currentSessionId };
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected to OpenClaw Gateway');
    }

    this.responseBuffer = '';
    this.isResponding = true;
    this.emit({ type: 'status', status: 'running' });

    await this.rpc('chat.send', {
      sessionKey: this.config.sessionKey,
      message: prompt,
    });
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    if (!this.connected) return;

    try {
      await this.rpc('chat.cancel', {
        sessionKey: this.config.sessionKey,
      });
    } catch {
      // Best effort cancellation
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
      await this.rpc('permission.respond', {
        requestId,
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
