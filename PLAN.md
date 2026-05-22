# SAP S/4HANA Embedded Finance Chrome Extension — Build Plan

_Last updated: 2026-04-20_

## 1. What we're building

A Chrome Extension (Manifest V3) that runs alongside SAP S/4HANA Public Cloud in the user's browser and provides expert analysis and navigation help, with a focus on Embedded Finance use cases: Cashflow Analysis, AR Factoring, PO Financing, and Request to Pay.

UX inspiration: the Claude Chrome extension side panel — a conversational assistant that sees the current page and can answer questions, suggest next steps, and surface relevant SAP documentation. Unlike the Claude extension, this one is **model-agnostic**: the user picks their LLM provider.

## 2. Locked-in decisions (from kickoff 2026-04-20)

| Decision | Choice | Consequence |
|---|---|---|
| SAP data access | DOM scraping of Fiori UI | Content scripts; no API enablement required up front; grounding must carry more weight |
| LLM providers (v1) | Anthropic Claude + Local/Ollama | Provider abstraction built for OpenAI/Gemini to drop in later |
| Distribution | Dev-sandbox first, Chrome Web Store eventually | MV3 from day one, clean permissions, no remote code |
| Environment | Existing S/4HANA Public Cloud trial (user shares login) | Mock DOM fixtures until live-testing phase |
| UX pattern | Side panel, conversational | Uses Chrome `sidePanel` API |

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Fiori Launchpad (tab)                    │
│  ┌─────────────────────┐     ┌────────────────────────────┐ │
│  │  Fiori app content  │◄────│  Content script            │ │
│  │  (DOM)              │     │  - detects app ID          │ │
│  └─────────────────────┘     │  - extracts visible fields │ │
│                              │  - posts context to SW     │ │
│                              └────────────┬───────────────┘ │
└───────────────────────────────────────────┼─────────────────┘
                                            │
                 ┌──────────────────────────▼───────────────────────┐
                 │          Service worker (background)             │
                 │  - routes messages                               │
                 │  - holds model adapters (Claude, Ollama)         │
                 │  - runs grounding / retrieval                    │
                 │  - handles skills                                │
                 └──────────────────────────┬───────────────────────┘
                                            │
┌───────────────────────────────────────────▼────────────────────┐
│                          Side panel (chat UI)                   │
│  - conversation, model picker, skill launcher, settings         │
└─────────────────────────────────────────────────────────────────┘
```

Key modules:
- **`sap-reader/`** — DOM extractors per Fiori app family. Starts with a generic "shell" reader (detects the current Fiori app ID, title, key visible fields). Grows per app.
- **`providers/`** — `ModelProvider` interface plus `ClaudeProvider` and `OllamaProvider`. Adapters convert a normalized `ChatRequest` into the provider's native format.
- **`grounding/`** — local knowledge base (SAP Fiori app metadata, embedded finance concepts, glossary). Lightweight retrieval (keyword + embedding lookup) injects relevant snippets into prompts.
- **`skills/`** — named workflows like "explain this PO's financing options" or "draft a request-to-pay flow" that compose prompt + grounding + optional DOM actions.
- **`settings/`** — provider keys, default model, enabled skills, integration credentials (later).
- **`integrations/`** — bank/fintech API adapters (last MVP). Abstracted so users can plug in their provider of choice.

Security posture for Web Store readiness:
- MV3, no remote script loading, no `unsafe-eval`.
- `host_permissions` declared narrowly (SAP S/4HANA Public Cloud domains, the user's configured bank/fintech endpoints, and the LLM endpoints). Everything else uses `optional_host_permissions`.
- API keys stored in `chrome.storage.local` only; never synced, never logged.
- Privacy policy + data flow diagram written alongside v1.0.0.

## 4. MVP roadmap

Each MVP is independently usable and reviewable. We ship (to ourselves) between them.

### MVP 1 — "Hello Fiori" (Simple Extension)
Goal: a side panel that opens on S/4HANA tabs and echoes what it can see on the page.

- MV3 scaffold (`manifest.json`, background service worker, side panel, content script).
- Content script detects when we're on an S/4HANA Fiori Launchpad URL; grabs `document.title`, the current Fiori app ID from the URL hash (e.g., `#SalesOrder-manage`), and a short DOM summary.
- Side panel shows: "You're on app X. I can see N tiles / this business object." Plus a text box that for now just replies with a stub.
- No LLM yet. No keys. Runs unpacked.
- **Exit criteria:** we load it, pin it, open a Fiori app, and see the detected context in the side panel.

### MVP 2 — Model Configuration
Goal: the text box becomes a real chat against a real model.

- Settings page with provider picker: Anthropic Claude (API key) and Ollama (endpoint URL + model name).
- `ModelProvider` interface + both adapters. Streaming responses into the side panel.
- Current Fiori DOM context is injected as a system prompt prefix (the "what I'm seeing now" block).
- Error handling: expired key, unreachable Ollama, rate limit.
- **Exit criteria:** with a configured provider, we can ask "what is this screen showing me?" and get a correct answer grounded in the DOM summary.

### MVP 3 — Grounding (make it smarter about SAP)
Goal: the extension stops being a generic chatbot and starts sounding like an SAP expert.

- Build a local knowledge pack containing:
  - SAP Fiori app metadata (app ID → name, role, typical business object, help doc URL). Seed from the Fiori Apps Library — I'll research the best machine-readable source with you.
  - Embedded finance glossary (Cashflow, AR Factoring, PO Financing, Request-to-Pay — terms, actors, data fields, typical workflows).
  - Snippets from the S/4HANA Public Edition help docs for the embedded-finance-adjacent apps.
- Lightweight retrieval: keyword match + optional embeddings (pre-computed, shipped with the extension — no runtime embedding API needed).
- Grounding prompt scaffolding: `<sap_context>` block with the top-k retrieved snippets, cited with doc URLs the user can click.
- **Exit criteria:** ask "what reports should I run to forecast next quarter's cashflow?" on a random Fiori page and get a grounded answer that cites specific Fiori apps by ID with working links.

### MVP 4 — Skills
Goal: the side panel has one-click expert workflows.

- Skill registry format (probably a JSON manifest + a prompt template + optional DOM-action hooks).
- Seed skills:
  - **"Analyze this PO for financing"** — reads PO fields from DOM, combines with grounding, outputs a financing recommendation.
  - **"Cashflow quick-look"** — navigates/opens the right Fiori cash management app, summarizes the user's current position.
  - **"Draft a Request-to-Pay message"** — takes an open invoice, produces a customer-ready R2P draft.
  - **"Explain this screen to me"** — generic teaching mode.
- Skill launcher UI in the side panel.
- **Exit criteria:** each seed skill completes end-to-end against a real Fiori screen in the provisioned trial.

### MVP 5 — Bank / Fintech Integration
Goal: close the loop — the extension can actually call out to a financing or payment partner from inside S/4HANA.

- Integration adapter interface (like model providers, but for banks/fintechs).
- Reference integration with **one** partner — I'll research SAP Fioneer's embedded finance API plus one or two public fintech sandboxes (Stripe Capital, Modern Treasury, TrueLayer / GoCardless for R2P — we'll pick together).
- Credential management in settings (OAuth where possible, encrypted `chrome.storage.local` otherwise).
- End-to-end flow: on a PO screen → skill invokes → adapter pulls a financing quote → displayed in side panel with a "send this back into SAP" option (which, without write APIs, means prefilling a form or producing an email draft).
- **Exit criteria:** a live demo where a Fiori PO triggers an outside financing quote in under a minute.

### Post-MVP (parking lot)
- Add OpenAI + Gemini providers.
- Hybrid DOM+OData access when user is ready to enable APIs.
- Chrome Web Store submission: privacy policy, permissions justification doc, marketing assets, a short explainer video.
- Enterprise packaging (per-org allow-listed providers, org-managed API keys).
- Multi-language (SAP is global).

## 5. Research answers (resolved 2026-04-20)

1. **Fiori app ID extraction.** The URL hash carries a `#<SemanticObject>-<Action>` intent — e.g., `#Customer-manageLineItems`. We use that intent string as the primary lookup key and resolve it against our scraped catalog to get the F-number (e.g., `F0711` for Customer-manageLineItems) and the rest of the app metadata.
   - Example URL: `https://my429998.s4hana.cloud.sap/ui?sap-language=en&help-mixedLanguages=false#Customer-manageLineItems&/?sap-iapp-state=...`
   - Fiori Apps Library detail URL pattern: `https://fioriappslibrary.hana.ondemand.com/sap/fix/externalViewer/#/detail/Apps('<F-number>')/S36`
2. **Fiori Apps Library data.** No API. We scrape once and bundle the catalog. Use a cheap Claude model (Haiku-class) to normalize the scraped HTML into structured JSON — this is a one-time offline build step, not runtime.
3. **Initial scope.** Start with **Invoice Financing** and **Request to Pay**, anchored on the **Customer - Manage Line Items** app (F0711, intent `Customer-manageLineItems`). Everything in MVPs 3 and 4 is built against that app first, then expanded.
4. **Fintech sandbox.** None available right now. MVP 5 will ship with a **mock integration adapter** demonstrating the interface, plus research to identify a public test API we could wire up later. The adapter interface is the deliverable; a live third-party call is a stretch goal.
5. **Write-back pattern.** Fiori supports **URL-parameter navigation** documented per-app in the Fiori Apps Library under *Implementation Information* → *Target Mapping(s)*. So "writing back" without OData means constructing an intent URL with parameters that deep-links the user into the right Fiori screen with fields pre-populated. Our skills will generate these URLs from grounding data.

## 6. How we'll work

- One MVP at a time, each closed out before the next starts.
- I default to creating actual working files in your `SAP Chrome Extension/` workspace folder — not showing code in chat.
- Before each MVP I'll ask you any new decisions that branch the design.
- You can always say "stop, let's go back and rework MVP N" — the plan is not precious.
