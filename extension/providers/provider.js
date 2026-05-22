// providers/provider.js
// Factory that reads chrome.storage.local and returns the configured provider.
// The ModelProvider base class lives in base.js to avoid circular imports.
//
// Static imports are required — dynamic import() is forbidden in
// ServiceWorkerGlobalScope (HTML spec / https://github.com/w3c/ServiceWorker/issues/1356).

import { ClaudeProvider } from './claude.js';
import { OllamaProvider } from './ollama.js';

// Re-export so callers only need one import.
export { ModelProvider } from './base.js';

export function providerFromConfig(cfg = {}) {
  if (cfg.provider === 'claude') {
    const c = cfg.claude || {};
    if (!c.apiKey) return null;
    return new ClaudeProvider(c);
  }

  if (cfg.provider === 'ollama') {
    const o = cfg.ollama || {};
    return new OllamaProvider(o);
  }

  return null;
}

/**
 * Read saved settings and return a configured ModelProvider, or null if
 * the user hasn't set one up yet.
 */
export async function loadProvider() {
  const cfg = await chrome.storage.local.get(['provider', 'claude', 'ollama']);
  return providerFromConfig(cfg);
}
