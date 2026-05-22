// Side panel script — wires the UI to the service worker.
// MVP 2: real streaming chat — LLM fetches are proxied through the service
// worker to avoid CORS restrictions on extension pages.

'use strict';

// ── State ─────────────────────────────────────────────────────

let currentContext      = null;
let conversationHistory = []; // [{role, content}]
let isStreaming         = false;

const ACTION_BLOCK_RE = /<fiori_action>\s*([\s\S]*?)\s*<\/fiori_action>/gi;

// ── DOM refs ──────────────────────────────────────────────────

const statusEl        = document.getElementById('status');
const ctxApp          = document.getElementById('ctx-app');
const ctxIntent       = document.getElementById('ctx-intent');
const ctxTenant       = document.getElementById('ctx-tenant');
const ctxTable        = document.getElementById('ctx-table');
const ctxHeadings     = document.getElementById('ctx-headings');
const ctxTablePreview = document.getElementById('ctx-table-preview');
const messagesEl      = document.getElementById('messages');
const composer        = document.getElementById('composer');
const promptInput     = document.getElementById('prompt-input');
const refreshBtn      = document.getElementById('refresh-btn');
const settingsBtn     = document.getElementById('settings-btn');
const modelIndicatorEl = document.getElementById('model-indicator');

// ── Helpers ───────────────────────────────────────────────────

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Convert [label](https://...) Markdown links -> <a> tags.
// Text outside links is HTML-escaped. Only https:// URLs are allowed.
function renderMarkdown(text) {
  const linkRe = /\[([^\]]{1,200})\]\((https:\/\/[^)]{1,1000})\)/g;
  const parts  = [];
  let lastIndex = 0;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    parts.push(escapeHtml(text.slice(lastIndex, m.index)));
    const label = escapeHtml(m[1]);
    const url   = escapeHtml(m[2]);
    parts.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    lastIndex = m.index + m[0].length;
  }
  parts.push(escapeHtml(text.slice(lastIndex)));
  return parts.join('').replace(/\n/g, '<br>');
}

function stripActionBlocks(text) {
  ACTION_BLOCK_RE.lastIndex = 0;
  return String(text || '')
    .replace(ACTION_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractActionBlocks(text) {
  const actions = [];
  ACTION_BLOCK_RE.lastIndex = 0;

  let match;
  while ((match = ACTION_BLOCK_RE.exec(String(text || ''))) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          if (item && typeof item.type === 'string') actions.push(item);
        });
      } else if (parsed && typeof parsed.type === 'string') {
        actions.push(parsed);
      }
    } catch {
      // Ignore malformed blocks. The visible reply still renders.
    }
  }

  return actions;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeAction(action) {
  if (!action || !action.type) return 'Run automation action';

  if (action.type === 'SET_FILTER_VALUE') {
    return `Set filter ${action.label || 'field'} to ${action.value || 'empty'}`;
  }
  if (action.type === 'PRESS_GO') {
    return `Press ${action.text || 'Go'}`;
  }
  if (action.type === 'CLICK_TEXT_BUTTON') {
    return `Click button ${action.text || ''}`.trim();
  }
  if (action.type === 'NAVIGATE_FIORI_URL') {
    return 'Navigate to requested Fiori URL';
  }
  return action.type;
}

function summarizeActionResult(action, result, step) {
  const prefix = `${step}. ${describeAction(action)}`;
  if (!result || !result.ok) {
    return `${prefix} — failed${result && result.error ? `: ${result.error}` : ''}`;
  }
  return `${prefix} — done`;
}

// ── Render context card ───────────────────────────────────────

function clearContext() {
  ctxApp.textContent    = '—';
  ctxIntent.textContent = '—';
  ctxTenant.textContent = '—';
  if (ctxTable) ctxTable.textContent = '—';
  ctxHeadings.textContent   = '';
  ctxTablePreview.innerHTML = '';
}

function renderContext(ctx) {
  currentContext = ctx; // keep for system prompt
  if (!ctx) {
    clearContext();
    return;
  }

  const intentStr = ctx.intent ? ctx.intent.raw : null;

  ctxApp.textContent    = ctx.title || '—';
  ctxIntent.textContent = intentStr || '—';
  ctxTenant.textContent = ctx.tenantHost || '—';

  if (ctx.table) {
    if (ctxTable) {
      ctxTable.textContent = `${ctx.table.type} · ${ctx.table.totalVisible} row(s) visible`;
    }
    renderTablePreview(ctx.table);
  } else {
    if (ctxTable) ctxTable.textContent = 'None detected';
    ctxTablePreview.innerHTML = '';
  }

  if (ctx.headings && ctx.headings.length > 0) {
    ctxHeadings.innerHTML = ctx.headings
      .map(h => `<div class="heading-item">${escapeHtml(h)}</div>`)
      .join('');
  } else {
    ctxHeadings.textContent = 'No headings found';
  }
}

function renderTablePreview(table) {
  ctxTablePreview.innerHTML = '';
  if (!table || !table.rows || table.rows.length === 0) return;

  const MAX_COLS = 12;
  const MAX_ROWS = 10;

  const el = document.createElement('table');
  el.className = 'data-table';

  if (table.headers && table.headers.length > 0) {
    const thead = el.createTHead();
    const tr    = thead.insertRow();
    table.headers.slice(0, MAX_COLS).forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      tr.appendChild(th);
    });
  }

  const tbody = el.createTBody();
  table.rows.slice(0, MAX_ROWS).forEach(row => {
    const tr = tbody.insertRow();
    row.slice(0, MAX_COLS).forEach(cell => {
      const td = tr.insertCell();
      td.textContent = cell;
    });
  });

  ctxTablePreview.appendChild(el);
}

// ── Fetch context from active tab ─────────────────────────────

async function refreshContext() {
  setStatus('Detecting…');

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (e) {
    setStatus('Error querying tabs');
    return;
  }

  if (!tab || !tab.url) {
    setStatus('No active tab');
    clearContext();
    return;
  }

  const isFiori =
    tab.url.includes('.s4hana.cloud.sap') ||
    tab.url.includes('.hana.ondemand.com');

  if (!isFiori) {
    setStatus('Not an S/4HANA tab');
    clearContext();
    return;
  }

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type:  'REQUEST_FIORI_CONTEXT',
      tabId: tab.id,
    });
  } catch (e) {
    setStatus('Service worker error');
    return;
  }

  if (resp && resp.context) {
    const ctx       = resp.context;
    const intentStr = ctx.intent ? ctx.intent.raw : null;
    setStatus(intentStr || ctx.title || 'Fiori page detected');
    renderContext(ctx);
  } else {
    setStatus('Waiting for Fiori…');
    clearContext();
  }
}

async function getActiveFioriTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id || !tab.url) return null;

  const isFiori =
    tab.url.includes('.s4hana.cloud.sap') ||
    tab.url.includes('.hana.ondemand.com');
  return isFiori ? tab : null;
}

function setAutomationStatus(text, color) {
  // Manual automation controls were removed from the panel UI.
  // Keep this as a no-op-friendly hook so assistant-driven actions can
  // continue reusing the same execution path without touching the layout.
  return { text, color: color || '' };
}

async function runAutomationAction(action) {
  setAutomationStatus('Running…', '');

  let tab;
  try {
    tab = await getActiveFioriTab();
  } catch (e) {
    setAutomationStatus('Tab query failed', '#ff453a');
    return { ok: false, error: 'Tab query failed' };
  }

  if (!tab) {
    setAutomationStatus('Open a Fiori tab first', '#ff453a');
    return { ok: false, error: 'Open a Fiori tab first' };
  }

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'RUN_FIORI_ACTION',
      tabId: tab.id,
      action,
    });
  } catch (e) {
    setAutomationStatus('Service worker error', '#ff453a');
    return { ok: false, error: 'Service worker error' };
  }

  if (!result || !result.ok) {
    setAutomationStatus((result && result.error) || 'Action failed', '#ff453a');
    return result || { ok: false, error: 'Action failed' };
  }

  setAutomationStatus(action.type + ' ✓', '#30d158');
  if (result.context) {
    renderContext(result.context);
    setStatus(result.context.intent?.raw || result.context.title || 'Fiori page updated');
  } else {
    setTimeout(refreshContext, 500);
  }
  return result;
}

async function runAssistantActions(actions) {
  const summaries = [];

  for (let idx = 0; idx < actions.length; idx += 1) {
    const action = actions[idx];
    const result = await runAutomationAction(action);
    summaries.push(summarizeActionResult(action, result, idx + 1));

    if (!result || !result.ok) break;

    if (action.type === 'NAVIGATE_FIORI_URL') {
      await delay(2500);
    } else {
      await delay(250);
    }
  }

  return summaries;
}

// ── Listen for push updates from the service worker ───────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'FIORI_CONTEXT_UPDATE') {
    const ctx       = msg.context;
    const intentStr = ctx && ctx.intent ? ctx.intent.raw : null;
    setStatus(intentStr || (ctx && ctx.title) || 'Fiori page updated');
    renderContext(ctx);
  }
});

// ── Chat ─────────────────────────────────────────────────────

function buildSystemPrompt(ctx) {
  const base = [
    'You are an expert SAP S/4HANA Embedded Finance assistant embedded as a Chrome side panel.',
    'You help users understand screens, navigate Fiori apps, and reason about Embedded Finance workflows',
    '(Invoice Financing, Request to Pay, Cashflow Analysis, AR Factoring, PO Financing).',
    'When referencing navigation URLs, always format them as Markdown links: [descriptive label](url).',
  ].join(' ');

  if (!ctx) return base;

  const intentStr = ctx.intent ? ctx.intent.raw : null;

  const lines = [
    base, '',
    '## Current screen context', '',
    `App / Title : ${ctx.title || '—'}`,
    `Fiori Intent: ${intentStr || '—'}`,
    `Tenant      : ${ctx.tenantHost || '—'}`,
  ];

  // Active filter bar selections (captured by content script)
  if (ctx.filterValues && Object.keys(ctx.filterValues).length > 0) {
    lines.push('', '### Active filter values');
    for (const [k, v] of Object.entries(ctx.filterValues)) {
      lines.push(`- ${k}: ${v}`);
    }
  }

  if (ctx.headings && ctx.headings.length > 0) {
    lines.push('', '### Visible headings', ...ctx.headings.map(h => `- ${h}`));
  }
  if (ctx.table) {
    lines.push('', `### Visible table (${ctx.table.type}, ${ctx.table.totalVisible} rows)`);
    if (ctx.table.headers?.length) lines.push('Columns: ' + ctx.table.headers.join(' | '));
    if (ctx.table.rows?.length) {
      ctx.table.rows.slice(0, 5).forEach(row => lines.push(row.join(' | ')));
    }
  }

  // Navigation capability block — injected when the current app is in the catalog
  const catalog  = typeof window.FIORI_CATALOG !== 'undefined' ? window.FIORI_CATALOG : null;
  const appEntry = catalog && intentStr ? catalog[intentStr] : null;
  if (appEntry) {
    const host = ctx.tenantHost || 'YOUR-TENANT.s4hana.cloud.sap';

    lines.push('', '## Navigation capability');
    lines.push(
      `This app (${appEntry.appId} — ${appEntry.title}) supports deep-link navigation via ` +
      `Fiori intent URLs. You can construct pre-filtered links for the user to click.`
    );
    lines.push('');
    lines.push(`URL pattern:  https://${host}/ui?sap-language=en#${intentStr}?<params>`);
    lines.push('');
    lines.push('Available filter parameters:');
    for (const p of appEntry.navParams) {
      let detail = `${p.description}`;
      if (p.values) {
        detail += '  Allowed values: ' + p.values.map(([v, l]) => `"${v}" (${l})`).join(', ');
      }
      lines.push(`  ${p.name}  (${p.type})  —  ${detail}`);
    }
    lines.push('');

    const sysStr = Object.entries(appEntry.systemParams)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    lines.push(`System params (always append): ${sysStr}`);
    lines.push('');

    // Concrete example URL using values visible on the current screen where possible
    const exParams = {};
    if (ctx.filterValues) {
      // Try to map known filter labels to URL param names
      const fv = ctx.filterValues;
      const pick = (labels) => {
        for (const l of labels) {
          for (const [k, v] of Object.entries(fv)) {
            if (k.toLowerCase().includes(l.toLowerCase())) return v;
          }
        }
        return null;
      };
      const cust = pick(['customer', 'konto', 'debitor']);
      const cocd = pick(['company', 'buchungskreis']);
      if (cust) exParams.Customer     = cust;
      if (cocd) exParams.CompanyCode  = cocd;
    }
    if (!exParams.Customer)    exParams.Customer    = '10000';
    if (!exParams.CompanyCode) exParams.CompanyCode = '1010';
    exParams.DueItemCategory = '3'; // overdue

    const exUrl = typeof window.buildFioriUrl === 'function'
      ? window.buildFioriUrl(host, intentStr, exParams)
      : `https://${host}/ui?sap-language=en#${intentStr}?Customer=${exParams.Customer}&CompanyCode=${exParams.CompanyCode}&DueItemCategory=3&sap-fiori-id=F0711&sap-tag=superiorAction&sap-keep-alive=restricted`;

    lines.push('Example — overdue items pre-filtered:');
    lines.push(`[Open overdue items for customer ${exParams.Customer}](${exUrl})`);
    lines.push('');
    lines.push(
      'IMPORTANT: Whenever the user asks to filter, drill-down, navigate, or view specific data, ' +
      'ALWAYS provide a ready-to-click link built from the parameters above. ' +
      'Use values visible in "Active filter values" or the table when constructing the link.'
    );
  }

  lines.push('', '## Screen automation');
  lines.push('You can operate the current SAP screen by emitting one or more action blocks after a short explanation.');
  lines.push('Use these exact formats with raw JSON and no code fences:');
  lines.push('<fiori_action>{"type":"SET_FILTER_VALUE","label":"Company Code","value":"1010"}</fiori_action>');
  lines.push('<fiori_action>{"type":"PRESS_GO","text":"Go"}</fiori_action>');
  lines.push('<fiori_action>{"type":"CLICK_TEXT_BUTTON","text":"Adapt Filters"}</fiori_action>');
  lines.push('<fiori_action>{"type":"NAVIGATE_FIORI_URL","url":"https://..."}</fiori_action>');
  lines.push('Rules:');
  lines.push('- Only use action blocks when the user clearly wants to change the current screen.');
  lines.push('- Prefer SET_FILTER_VALUE + PRESS_GO for the current screen.');
  lines.push('- Use NAVIGATE_FIORI_URL only when opening or deep-linking to another screen is better.');
  lines.push('- Put each action in its own <fiori_action> block.');
  lines.push('- Never wrap action blocks in backticks or Markdown code fences.');
  lines.push('- Prefer labels and values visible in the current context.');

  return lines.join('\n');
}

function appendMessage(role, text, labelText) {
  const div   = document.createElement('div');
  div.className = `message message-${role}`;
  const label = document.createElement('span');
  label.className = 'message-role';
  label.textContent = labelText || (role === 'user' ? 'You' : 'Embedded Finance Agent');
  const body = document.createElement('p');
  body.textContent = text;
  div.appendChild(label);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return body; // caller can update .textContent for streaming
}

function finishStreaming() {
  isStreaming          = false;
  promptInput.disabled = false;
  promptInput.focus();
}

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (isStreaming) return;
  const text = promptInput.value.trim();
  if (!text) return;

  promptInput.value    = '';
  promptInput.disabled = true;
  isStreaming          = true;

  appendMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });

  const responseBody = appendMessage('assistant', '…');
  const requestId    = crypto.randomUUID();

  // Open a dedicated port for this request.
  // Port messaging avoids "receiving end does not exist" errors and keeps
  // the service worker alive for the duration of the stream.
  const port = chrome.runtime.connect({ name: 'llm-stream' });

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.requestId !== requestId) return;

    if (msg.type === 'LLM_PROVIDER') {
      modelIndicatorEl.textContent = msg.name;
      return;
    }
    if (msg.type === 'LLM_CHUNK') {
      if (responseBody.textContent === '…') responseBody.textContent = '';
      responseBody.textContent += msg.text;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }
    if (msg.type === 'LLM_DONE') {
      const fullText    = responseBody.textContent;
      const actions     = extractActionBlocks(fullText);
      const visibleText = stripActionBlocks(fullText) || (actions.length > 0 ? 'Running requested automation…' : fullText);

      conversationHistory.push({
        role: 'assistant',
        content: visibleText || 'Executed requested automation.',
      });

      // Render Markdown links as clickable anchors now that streaming is complete
      responseBody.innerHTML = renderMarkdown(visibleText);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      if (actions.length > 0) {
        const summaries = await runAssistantActions(actions);
        if (summaries.length > 0) {
          const summaryBody = appendMessage('assistant', summaries.join('\n'), 'Automation');
          summaryBody.innerHTML = renderMarkdown(summaries.join('\n'));
        }
      }

      port.disconnect();
      finishStreaming();
      return;
    }
    if (msg.type === 'LLM_ERROR') {
      if (msg.message === 'NOT_CONFIGURED') {
        responseBody.parentElement.querySelector('.message-role').textContent = 'Notice';
        responseBody.textContent =
          'No LLM configured. Click \u2699 to open Settings and add a Claude API key or Ollama endpoint.';
      } else {
        responseBody.textContent = `\u274c ${msg.message}`;
      }
      conversationHistory.pop();
      port.disconnect();
      finishStreaming();
    }
  });

  port.onDisconnect.addListener(() => {
    // SW disconnected unexpectedly — make sure we unblock the UI.
    if (isStreaming) {
      if (responseBody.textContent === '…') {
        responseBody.textContent = '\u274c Connection to service worker lost. Try reloading the extension.';
        conversationHistory.pop();
      }
      finishStreaming();
    }
  });

  port.postMessage({
    type:     'LLM_REQUEST',
    requestId,
    messages: conversationHistory.slice(-20),
    system:   buildSystemPrompt(currentContext),
  });
});

// Shift+Enter = newline; plain Enter = send
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

// ── Connection test ──────────────────────────────────────────

function testConnection() {
  const port = chrome.runtime.connect({ name: 'llm-stream' });
  port.onMessage.addListener((msg) => {
    if (msg.type !== 'LLM_TEST_RESULT') return;
    port.disconnect();
    if (msg.ok) {
      modelIndicatorEl.textContent = `✓ ${msg.name}`;
      modelIndicatorEl.style.color = '#30d158'; // green
    } else if (msg.error === 'NOT_CONFIGURED') {
      modelIndicatorEl.textContent = 'Not configured — click ⚙';
      modelIndicatorEl.style.color = '';
    } else {
      modelIndicatorEl.textContent = `❌ ${msg.error}`;
      modelIndicatorEl.style.color = '#ff453a'; // red
    }
  });
  port.onDisconnect.addListener(() => {
    if (modelIndicatorEl.textContent === 'Checking…') {
      modelIndicatorEl.textContent = 'SW unavailable — reload extension';
      modelIndicatorEl.style.color = '#ff453a';
    }
  });
  port.postMessage({ type: 'LLM_TEST' });
}

function handleProviderSettingsChange(changes, areaName) {
  if (areaName !== 'local') return;
  if (!changes.provider && !changes.claude && !changes.ollama) return;
  testConnection();
}

// ── Refresh button & settings button ─────────────────────────

refreshBtn.addEventListener('click', refreshContext);
settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener(handleProviderSettingsChange);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') testConnection();
});

window.addEventListener('focus', testConnection);

// ── Init ──────────────────────────────────────────────────────

testConnection();
refreshContext();
