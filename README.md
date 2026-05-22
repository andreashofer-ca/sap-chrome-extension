# SAP Embedded Finance Agent (Chrome Extension)

Manifest V3 Chrome extension that adds an SAP-aware side panel assistant to S/4HANA Public Cloud pages.

## What It Does

- Detects Fiori context from the active SAP tab (intent, headings, table preview, filter values).
- Streams LLM responses through the background service worker (Claude or Ollama).
- Supports assistant-driven UI automation via structured action blocks.
- Provides grounding metadata for known Fiori intents.

## Project Structure

- `extension/manifest.json`: MV3 manifest, permissions, content script, side panel, options page.
- `extension/background/service-worker.js`: message router, provider loading, streaming proxy.
- `extension/content/fiori-detector.js`: intent/table/filter extraction + action execution in page context.
- `extension/providers/`: provider abstraction and adapters.
  - `base.js`: `ModelProvider` interface.
  - `provider.js`: provider factory + settings loading.
  - `claude.js`: Anthropic streaming adapter.
  - `ollama.js`: Ollama streaming adapter + model resolution.
- `extension/grounding/catalog.js`: intent-to-app grounding catalog and URL builder.
- `extension/sidepanel/`: chat UI.
  - `index.html`: side panel shell.
  - `sidepanel.js`: context rendering, chat streaming, automation orchestration.
  - `sidepanel.css`: styling.
- `extension/settings/`: provider configuration UI and persistence.

## Runtime Message Flow

1. Content script extracts context and sends `FIORI_CONTEXT`.
2. Service worker forwards updates as `FIORI_CONTEXT_UPDATE`.
3. Side panel requests current context with `REQUEST_FIORI_CONTEXT`.
4. Side panel opens a `llm-stream` port and sends `LLM_REQUEST`.
5. Service worker loads configured provider and streams `LLM_CHUNK` messages back.
6. Side panel detects `<fiori_action>` blocks and invokes `RUN_FIORI_ACTION` as needed.

## Setup

1. Open Chrome Extensions (`chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` directory.
4. Open the extension settings page and configure one provider:
   - Claude: API key + model.
   - Ollama: endpoint + model (default endpoint `http://localhost:11434`).

## Local Validation

Quick syntax check:

```bash
find extension -name "*.js" -print0 | xargs -0 -n1 node --check
```

## Security Notes

- Keys are stored in `chrome.storage.local`.
- LLM calls are proxied through the service worker.
- Side panel link rendering allows only `https://` links.
- Model list rendering avoids `innerHTML` injection in settings.

## Contribution Guidelines

- Keep behavior changes isolated and small.
- Prefer additive comments over verbose prose.
- Preserve message contract names unless all call sites are updated.
- Validate JS syntax after any edit.
