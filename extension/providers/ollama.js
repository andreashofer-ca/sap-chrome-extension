// providers/ollama.js — Ollama local inference adapter (streaming NDJSON).

import { ModelProvider } from './base.js';

const DEFAULT_ENDPOINT = 'http://localhost:11434';
const DEFAULT_MODEL    = 'llama3.2';

async function fetchOllamaModels(endpoint) {
  const resp = await fetch(`${endpoint}/api/tags`);
  if (!resp.ok) {
    throw new Error(`Ollama HTTP ${resp.status}`);
  }

  const data = await resp.json().catch(() => ({}));
  const models = Array.isArray(data.models)
    ? data.models.map((m) => m.name).filter(Boolean)
    : [];

  return models;
}

function isCloudModelName(name) {
  return /(?:-cloud|:cloud)$/i.test(name || '');
}

function isVisionModelName(name) {
  return /(llava|moondream|vl:|:vl\b|-vl\b|vision|clip)/i.test(name || '');
}

function preferredOllamaModels(models) {
  return [...models].sort((a, b) => {
    const aVision = isVisionModelName(a);
    const bVision = isVisionModelName(b);
    if (aVision !== bVision) return aVision ? 1 : -1;

    return a.localeCompare(b);
  });
}

function summarizeAvailableModels(models) {
  return preferredOllamaModels(models).slice(0, 8).join(', ');
}

function pickSuggestedTextModel(models, currentModel) {
  const preferred = preferredOllamaModels(models);
  return preferred.find((name) => name !== currentModel && !isVisionModelName(name)) || null;
}

function parseErrorBody(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function friendly500Message(model, body, available) {
  const parsed = parseErrorBody(body);
  const rawError = parsed?.error || parsed?.Status || body || '';
  const suggested = pickSuggestedTextModel(available, model);
  const suggestion = suggested ? ` Try ${suggested} instead.` : '';

  if (/model failed to load/i.test(rawError)) {
    return [
      `The Ollama model ${model} could not start.`,
      'This usually means the model hit a resource/loading problem on the Ollama side.',
      suggestion.trim(),
    ].filter(Boolean).join(' ');
  }

  if (/internal server error/i.test(rawError)) {
    return [
      `Ollama accepted the request for ${model}, but the model backend failed with an internal server error.`,
      'This usually means the selected model is temporarily unavailable or failed upstream, not that the extension is broken.',
      suggestion.trim(),
    ].filter(Boolean).join(' ');
  }

  return [
    `Ollama returned HTTP 500 for ${model}.`,
    rawError ? `Details: ${String(rawError).slice(0, 220)}` : '',
    suggestion.trim(),
  ].filter(Boolean).join(' ');
}

function origin403Message(endpoint) {
  return [
    `Ollama HTTP 403 from ${endpoint}.`,
    'Ollama is blocking the Chrome extension origin.',
    'Set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.',
  ].join(' ');
}

export class OllamaProvider extends ModelProvider {
  constructor({ endpoint = DEFAULT_ENDPOINT, model = DEFAULT_MODEL } = {}) {
    super();
    this._endpoint = endpoint.replace(/\/$/, '');
    this._model    = model;
    this._resolvedModel = null;
  }

  get name() { return `Ollama · ${this._resolvedModel || this._model}`; }

  async resolveModel() {
    if (this._resolvedModel) return this._resolvedModel;

    const requested = (this._model || '').trim() || DEFAULT_MODEL;

    let models = [];
    try {
      models = await fetchOllamaModels(this._endpoint);
    } catch {
      this._resolvedModel = requested;
      return this._resolvedModel;
    }

    if (models.length === 0) {
      this._resolvedModel = requested;
      return this._resolvedModel;
    }

    const preferred = preferredOllamaModels(models);

    if (models.includes(requested)) {
      this._resolvedModel = requested;
      return this._resolvedModel;
    }

    // The extension used to default to llama3.2, but many local installs won't
    // have it pulled. If the user kept the default, pick the first installed
    // model so Ollama works out of the box.
    if (requested === DEFAULT_MODEL) {
      this._resolvedModel = preferred[0];
      return this._resolvedModel;
    }

    this._resolvedModel = requested;
    return this._resolvedModel;
  }

  async *stream(messages, system) {
    // Ollama uses OpenAI-style messages; system goes in the messages array.
    const allMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;
    const model = await this.resolveModel();

    let resp;
    try {
      resp = await fetch(`${this._endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream:   true,
          messages: allMessages,
        }),
      });
    } catch (e) {
      throw new Error(
        `Cannot reach Ollama at ${this._endpoint}. Is it running? (${e.message})`
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let available = [];
      try {
        available = await fetchOllamaModels(this._endpoint);
      } catch { /* ignore */ }

      let hint = '';
      if (resp.status === 404) {
        hint = ` — model "${model}" may not be pulled yet`;
        if (available.length > 0) {
          hint += `. Installed models: ${summarizeAvailableModels(available)}`;
        }
      } else if (resp.status === 403) {
        throw new Error(origin403Message(this._endpoint));
      } else if (resp.status === 500) {
        throw new Error(friendly500Message(model, text, available));
      }
      throw new Error(`Ollama HTTP ${resp.status}${hint}: ${text.slice(0, 200)}`);
    }

    // Parse NDJSON stream (one JSON object per line).
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.message?.content) yield obj.message.content;
          if (obj.done) return;
        } catch { /* ignore */ }
      }
    }
  }

  async test() {
    const model = await this.resolveModel();
    let resp;
    try {
      resp = await fetch(`${this._endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: 'user', content: 'ping' }],
          options: { num_predict: 1 },
        }),
      });
    } catch (e) {
      return { ok: false, error: `Cannot reach Ollama at ${this._endpoint}` };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      let available = [];
      try {
        available = await fetchOllamaModels(this._endpoint);
      } catch { /* ignore */ }

      if (resp.status === 404) {
        const extra = available.length > 0
          ? ` Available models: ${summarizeAvailableModels(available)}`
          : '';
        return { ok: false, error: `Model not found: ${model} — run 'ollama pull ${model}'.${extra}` };
      }

      if (resp.status === 403) {
        return { ok: false, error: origin403Message(this._endpoint) };
      }

      if (resp.status === 500) {
        return {
          ok: false,
          error: friendly500Message(model, body, available),
        };
      }

      return {
        ok: false,
        error: `Ollama HTTP ${resp.status}${body ? `: ${body.slice(0, 240)}` : ''}`,
      };
    }
    return { ok: true, name: `Ollama · ${model}` };
  }
}
