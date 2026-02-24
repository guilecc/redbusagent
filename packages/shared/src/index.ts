/**
 * @redbusagent/shared — Barrel Export
 *
 * Single entry point for all shared types, interfaces, and constants.
 */

export * from './constants.js';
export * from './types/protocol.js';
export * from './vault/vault.js';
export * from './persona/persona-manager.js';
export * from './utils/model-fetcher.js';
export * from './mcp-catalog.js';

// Setup global overrides
import './utils/suppress-warnings.js';
