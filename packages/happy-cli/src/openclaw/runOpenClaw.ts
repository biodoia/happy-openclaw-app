/**
 * runOpenClaw - Entry point for launching Happy with an OpenClaw backend
 *
 * This module handles:
 * 1. Checking if the OpenClaw Gateway is reachable
 * 2. Creating the OpenClawBackend
 * 3. Registering it with Happy's agent system
 *
 * Usage:
 *   happy openclaw                     # Connect to local gateway
 *   happy openclaw --gateway-url ws://remote:18789/ws  # Connect to remote
 *
 * Environment variables:
 *   OPENCLAW_GATEWAY_URL   - WebSocket URL (default: ws://127.0.0.1:18789/ws)
 *   OPENCLAW_GATEWAY_TOKEN - Authentication token
 */

import { OpenClawBackend, type OpenClawConfig } from './OpenClawBackend';
import { agentRegistry } from '../agent/core';
import { logger } from '@/ui/logger';

/** Options for running OpenClaw */
export interface RunOpenClawOptions {
  /** Gateway WebSocket URL */
  gatewayUrl?: string;
  /** Authentication token */
  token?: string;
  /** Session key (default: "main") */
  sessionKey?: string;
  /** Working directory */
  cwd?: string;
}

/**
 * Create an OpenClaw backend instance.
 *
 * Unlike other agents that spawn a child process, OpenClaw connects
 * to an already-running Gateway via WebSocket.
 *
 * @param options - Configuration options
 * @returns The OpenClaw backend
 */
export function createOpenClawBackend(options: RunOpenClawOptions = {}): OpenClawBackend {
  const config: OpenClawConfig = {
    gatewayUrl: options.gatewayUrl,
    token: options.token,
    sessionKey: options.sessionKey,
    cwd: options.cwd || process.cwd(),
  };

  logger.debug('[OpenClaw] Creating backend with config:', {
    gatewayUrl: config.gatewayUrl || '(default)',
    sessionKey: config.sessionKey || 'main',
    cwd: config.cwd,
    hasToken: !!config.token,
  });

  return new OpenClawBackend(config);
}

/**
 * Register OpenClaw backend with the global agent registry.
 *
 * Call this during application initialization to make the
 * OpenClaw agent available as `happy openclaw`.
 */
export function registerOpenClawAgent(): void {
  agentRegistry.register('openclaw' as any, (opts) => {
    return createOpenClawBackend({
      cwd: opts.cwd,
      token: opts.env?.OPENCLAW_GATEWAY_TOKEN,
      gatewayUrl: opts.env?.OPENCLAW_GATEWAY_URL,
    });
  });
  logger.debug('[OpenClaw] Registered with agent registry');
}
