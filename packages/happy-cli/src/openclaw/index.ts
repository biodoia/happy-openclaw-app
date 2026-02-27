/**
 * OpenClaw Agent Module
 *
 * Provides a Happy agent backend that connects to OpenClaw Gateway
 * via WebSocket, enabling mobile/web control of OpenClaw sessions.
 *
 * @module openclaw
 */

export { OpenClawBackend, type OpenClawConfig } from './OpenClawBackend';
export { createOpenClawBackend, registerOpenClawAgent, type RunOpenClawOptions } from './runOpenClaw';
