/**
 * @redbusagent/shared — Constants
 *
 * Central source of truth for ports, timeouts, and configuration defaults
 * shared across the daemon and TUI processes.
 */

export const DEFAULT_PORT = 6600;
export const DEFAULT_HOST = '127.0.0.1';

export const HEARTBEAT_INTERVAL_MS = 5_000; // 5 seconds
export const WS_RECONNECT_DELAY_MS = 3_000; // 3 seconds

export const APP_NAME = 'redbusagent';
export const APP_VERSION = '0.1.0';
