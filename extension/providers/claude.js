// providers/claude.js — Anthropic Claude adapter (streaming SSE).

import { ModelProvider } from './base.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5';

export class ClaudeProvider extends ModelProvider {
  constructor({ apiKey, model = DEFAULT_MODEL } = {}) {
    super();
    this._apiKey = apiKey;
    this._model  = model;
  }

  get name() { return `Claude · ${this._model}`; }

  async *stream(messages, system) {
    const body = {
      model:      this._model,
      max_tokens: 1024,
      stream:     true,
      messages,
    };
    if (system) body.system = system;

    let resp;
    try {
      resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key':                              this._apiKey,
          'anthropic-version':                      '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type':                           'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`Network error reaching Anthropic: ${e.message}`);
    }

    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        msg = err?.error?.message || msg;
      } catch { /* ignore */ }
      if (resp.status === 401) msg = 'Invalid API key — check Settings.';
      if (resp.status === 429) msg = 'Rate limit reached — try again shortly.';
      throw new Error(msg);
    }

    // Parse Anthropic's SSE stream.
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep last incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data);
          if (
            evt.type === 'content_block_delta' &&
            evt.delta?.type === 'text_delta'
          ) {
            yield evt.delta.text;
          }
        } catch { /* ignore malformed lines */ }
      }
    }
  }

  async test() {
    let resp;
    try {
      resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key':                              this._apiKey,
          'anthropic-version':                      '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type':                           'application/json',
        },
        body: JSON.stringify({
          model: this._model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
    } catch (e) {
      return { ok: false, error: `Network error: ${e.message}` };
    }
    if (!resp.ok) {
      if (resp.status === 401) return { ok: false, error: 'Invalid API key' };
      if (resp.status === 404) return { ok: false, error: `Model not found: ${this._model}` };
      if (resp.status === 429) return { ok: false, error: 'Rate limit reached' };
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    return { ok: true, name: this.name };
  }
}
