// Service worker: opens side panel on action click, routes messages between
// content scripts and the side panel, and proxies all LLM fetches.
// Fetches must originate here — extension pages are blocked by CORS on the
// Anthropic API and other LLM endpoints, but service workers are not.

import { loadProvider, providerFromConfig } from '../providers/provider.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[FinanceCopilot] sidePanel.setPanelBehavior', err));
});

function isFioriUrl(url) {
  return Boolean(
    url && (
      url.includes('.s4hana.cloud.sap') ||
      url.includes('.hana.ondemand.com')
    )
  );
}

async function ensureFioriContentScript(tabId, url) {
  if (!tabId || !isFioriUrl(url)) return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/fiori-detector.js'],
    });
    return true;
  } catch (err) {
    console.warn('[FinanceCopilot] executeScript failed', err);
    return false;
  }
}

async function requestFioriContextFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_FIORI_CONTEXT' });
  } catch {
    return null;
  }
}

// ── Fiori context messages (content script ↔ side panel) ─────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'FIORI_CONTEXT') {
    const payload = {
      type: 'FIORI_CONTEXT_UPDATE',
      tabId: sender.tab && sender.tab.id,
      context: msg.context,
      ts: Date.now(),
    };
    chrome.runtime.sendMessage(payload).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Side panel asks for the latest context on a tab.
  if (msg && msg.type === 'REQUEST_FIORI_CONTEXT' && msg.tabId) {
    (async () => {
      let ctx = await requestFioriContextFromTab(msg.tabId);
      if (ctx) {
        sendResponse({ ok: true, context: ctx });
        return;
      }

      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      const injected = await ensureFioriContentScript(msg.tabId, tab && tab.url);
      if (!injected) {
        sendResponse({ ok: true, context: null });
        return;
      }

      // Give the newly injected script a brief moment to publish and then re-query.
      setTimeout(async () => {
        const retryCtx = await requestFioriContextFromTab(msg.tabId);
        sendResponse({ ok: true, context: retryCtx || null });
      }, 350);
    })();
    return true;
  }

  // Side panel asks the active SAP tab to perform an automation action.
  if (msg && msg.type === 'RUN_FIORI_ACTION' && msg.tabId && msg.action) {
    chrome.tabs.sendMessage(
      msg.tabId,
      { type: 'RUN_FIORI_ACTION', action: msg.action },
      (result) => {
        const err = chrome.runtime.lastError;
        if (err) {
          sendResponse({ ok: false, error: err.message || 'No content script receiver' });
          return;
        }
        sendResponse(result || { ok: false, error: 'No action result returned' });
      }
    );
    return true;
  }

  if (msg && msg.type === 'TEST_PROVIDER_CONFIG' && msg.config) {
    handleProviderConfigTest(msg.config)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: `Provider test failed: ${err.message}` }));
    return true;
  }
});

// ── LLM streaming via port (avoids "no receiving end" errors) ─
// The side panel opens a port named 'llm-stream' for each request.
// Ports keep the service worker alive and give a direct back-channel.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'llm-stream') return;

  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'LLM_REQUEST') {
      handleLlmRequest(msg, port);
    }
    if (msg && msg.type === 'LLM_TEST') {
      handleLlmTest(port);
    }
  });
});

async function handleLlmTest(port) {
  function send(obj) {
    try { port.postMessage(obj); } catch { /* port disconnected */ }
  }

  let provider;
  try {
    provider = await loadProvider();
  } catch (err) {
    send({ type: 'LLM_TEST_RESULT', ok: false, error: `Provider load failed: ${err.message}` });
    return;
  }

  if (!provider) {
    send({ type: 'LLM_TEST_RESULT', ok: false, error: 'NOT_CONFIGURED' });
    return;
  }

  const result = await provider.test();
  send({ type: 'LLM_TEST_RESULT', ...result });
}

async function handleProviderConfigTest(config) {
  let provider;
  try {
    provider = providerFromConfig(config);
  } catch (err) {
    return { ok: false, error: `Provider load failed: ${err.message}` };
  }

  if (!provider) {
    return { ok: false, error: 'NOT_CONFIGURED' };
  }

  return provider.test();
}

async function handleLlmRequest({ requestId, messages, system }, port) {
  function send(obj) {
    try { port.postMessage(obj); } catch { /* port already disconnected */ }
  }

  let provider;
  try {
    provider = await loadProvider();
  } catch (err) {
    send({ type: 'LLM_ERROR', requestId, message: `Provider load failed: ${err.message}` });
    return;
  }

  if (!provider) {
    send({ type: 'LLM_ERROR', requestId, message: 'NOT_CONFIGURED' });
    return;
  }

  send({ type: 'LLM_PROVIDER', requestId, name: provider.name });

  try {
    for await (const chunk of provider.stream(messages, system)) {
      send({ type: 'LLM_CHUNK', requestId, text: chunk });
    }
    send({ type: 'LLM_DONE', requestId });
  } catch (err) {
    send({ type: 'LLM_ERROR', requestId, message: err.message });
  }
}
