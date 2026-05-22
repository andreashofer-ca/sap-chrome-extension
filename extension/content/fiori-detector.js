// Content script — runs on every S/4HANA Fiori Launchpad page.
// Responsibilities:
//   1. Parse the Fiori intent from the URL hash (#SemanticObject-Action).
//   2. Pick the right table extractor (GridTable vs ResponsiveTable).
//   3. Publish a "context" snapshot to the background/side panel on
//      page changes and on-demand.
//
// Design goals:
//   - Zero dependencies, minimal DOM assumptions.
//   - Tolerant of redacted / blocked return values (side panel can re-extract).
//   - Easy to expand: add a new app-specific extractor by checking the intent.

(() => {
  'use strict';

  if (window.__fioriFinanceCopilotInjected) return;
  window.__fioriFinanceCopilotInjected = true;

  // --- intent parsing ---------------------------------------------------
  // Hash format examples:
  //   #Customer-manageLineItems
  //   #Customer-manageLineItems?sap-iapp-state=...
  //   #Shell-home
  const INTENT_RE = /^#([A-Za-z0-9_]+)-([A-Za-z0-9_]+)/;

  function parseIntent(hash) {
    const m = (hash || '').match(INTENT_RE);
    if (!m) return null;
    return {
      semanticObject: m[1],
      action: m[2],
      raw: `${m[1]}-${m[2]}`,
    };
  }

  // --- table extractors -------------------------------------------------
  // Utility: extract visible text from an element robustly.
  // SAP UI5 puts text in nested spans; innerText can be empty for off-screen
  // virtual rows.  We walk textContent and collapse whitespace.
  function cellText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // SAP UI5 GridTable / AnalyticalTable
  //   Container: [role=grid] or [role=treegrid]
  //   Headers:   [role=columnheader]  (live in a thead or colheader row)
  //   Data rows: tr[role=row] that do NOT contain [role=columnheader]
  //   Cells:     td[role=gridcell], [role=gridcell], [role=cell]
  function extractGridTable() {
    const headerEls = document.querySelectorAll('[role=columnheader]');
    if (headerEls.length === 0) return null;

    const headers = Array.from(headerEls)
      .map(cellText)
      .filter(Boolean);

    const allRows = document.querySelectorAll('tr[role=row]');
    const rows = Array.from(allRows)
      .filter(r => r.querySelector('[role=columnheader]') === null) // skip header rows
      .map(r =>
        Array.from(r.querySelectorAll('[role=gridcell], [role=cell], td'))
          .map(cellText)
      )
      .filter(cells => cells.some(c => c !== '')); // skip blank rows

    if (rows.length === 0) return null;
    return { type: 'GridTable', headers, rows, totalVisible: rows.length };
  }

  // SAP M Table (sap.m.Table / SmartTable wrapping sap.m.Table)
  //   Header cells: .sapMListTblHeaderCell, th[scope=col]
  //   Rows:         .sapMListTblRow, tr.sapMLIB
  //   Cells:        .sapMListTblCell, td.sapMListTblCell
  function extractResponsiveTable() {
    // Try header cells with multiple selectors
    let headerEls = document.querySelectorAll('.sapMListTblHeaderCell');
    if (headerEls.length === 0) headerEls = document.querySelectorAll('th[scope=col]');

    let rowEls = document.querySelectorAll('.sapMListTblRow');
    if (rowEls.length === 0) rowEls = document.querySelectorAll('tr.sapMLIB');
    if (rowEls.length === 0) return null;

    const headers = Array.from(headerEls).map(cellText).filter(Boolean);
    const rows = Array.from(rowEls).map(r => {
      let cells = r.querySelectorAll('.sapMListTblCell');
      if (cells.length === 0) cells = r.querySelectorAll('td');
      return Array.from(cells).map(cellText);
    }).filter(cells => cells.some(c => c !== ''));

    if (rows.length === 0) return null;
    return { type: 'ResponsiveTable', headers, rows, totalVisible: rows.length };
  }

  // Fallback: any HTML table with more than one row of data
  function extractGenericTable() {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headerEls = table.querySelectorAll('th');
      const rowEls    = table.querySelectorAll('tbody tr');
      if (rowEls.length === 0) continue;

      const headers = Array.from(headerEls).map(cellText).filter(Boolean);
      const rows = Array.from(rowEls)
        .map(r => Array.from(r.querySelectorAll('td')).map(cellText))
        .filter(cells => cells.some(c => c !== ''));

      if (rows.length > 0) {
        return { type: 'HTMLTable', headers, rows, totalVisible: rows.length };
      }
    }
    return null;
  }

  function extractTable() {
    return extractGridTable() || extractResponsiveTable() || extractGenericTable() || null;
  }

  // --- filter bar values -----------------------------------------------
  // SAP SmartFilterBar (.sapUiCompFilterBar) or sap.m.FilterBar (.sapMFilterBar).
  // Reads labelled input values and token (multi-value) selections.
  // Returns a flat object { labelText: value } or null if no filter bar found.
  function extractFilterValues() {
    const result = {};

    // Locate the filter bar container (best-effort)
    const bar = document.querySelector(
      '.sapUiCompFilterBar, .sapMFilterBar, [id*="filterBar"], [class*="FilterBar"]'
    );
    if (!bar) return null;

    // Single-value input fields with aria-label
    bar.querySelectorAll('input[aria-label]').forEach(inp => {
      const val = (inp.value || '').trim();
      if (!val) return;
      const label = inp.getAttribute('aria-label').trim();
      if (label) result[label] = val;
    });

    // Multi-value token groups (shows selected values as chips)
    bar.querySelectorAll('.sapMToken').forEach(tok => {
      const text = cellText(tok);
      if (!text) return;
      // Try to resolve the enclosing field label
      let label = 'Selected';
      const fieldEl = tok.closest('[aria-label]');
      if (fieldEl) {
        label = fieldEl.getAttribute('aria-label').trim() || label;
      } else {
        const labelEl = tok.closest('.sapUiCompFilterBarItem, .sapMFBFilter')
          ?.querySelector('.sapMLabelText, label');
        if (labelEl) label = cellText(labelEl) || label;
      }
      result[label] = result[label] ? result[label] + ', ' + text : text;
    });

    return Object.keys(result).length > 0 ? result : null;
  }

  // --- headings / page identity ----------------------------------------
  function extractHeadings() {
    return Array.from(document.querySelectorAll('h1, h2, [role=heading]'))
      .slice(0, 10)
      .map((h) => (h.innerText || '').trim())
      .filter(Boolean);
  }

  // --- ushell metadata (best-effort; don't rely on it) ------------------
  function extractUshell() {
    try {
      const c = window.sap && window.sap.ushell && window.sap.ushell.Container;
      if (!c || !c.getService) return null;
      const svc = c.getService('AppLifeCycle');
      const cur = svc && svc.getCurrentApplication && svc.getCurrentApplication();
      const intent = cur && cur.getIntent && cur.getIntent();
      return {
        hasUshell: true,
        applicationType: cur && cur.applicationType,
        intent: intent
          ? { semanticObject: intent.semanticObject, action: intent.action }
          : null,
      };
    } catch (e) {
      return { hasUshell: false, err: String(e).slice(0, 200) };
    }
  }

  // --- full context snapshot --------------------------------------------
  function buildContext() {
    const intent = parseIntent(location.hash);
    const table = extractTable();
    const headings = extractHeadings();
    const ushell = extractUshell();
    const filterValues = extractFilterValues();
    return {
      url: location.href,
      title: document.title,
      intent,       // primary signal
      ushell,       // diagnostic, not authoritative
      headings,
      table,
      filterValues, // active filter bar selections (null if no filter bar)
      tenantHost: location.host,
      extractedAt: new Date().toISOString(),
    };
  }

  // --- action helpers --------------------------------------------------
  function normalize(str) {
    return (str || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function pickInputByLabel(label) {
    const want = normalize(label);
    if (!want) return null;

    const candidates = Array.from(document.querySelectorAll('input, textarea'));
    for (const el of candidates) {
      const aria = normalize(el.getAttribute('aria-label'));
      const placeholder = normalize(el.getAttribute('placeholder'));
      if (aria.includes(want) || placeholder.includes(want)) return el;
    }

    const labels = Array.from(document.querySelectorAll('label, .sapMLabel, .sapMLabelText'));
    for (const labelEl of labels) {
      if (!normalize(cellText(labelEl)).includes(want)) continue;
      const field = labelEl.closest('[data-sap-ui], .sapUiCompFilterBarItem, .sapMFlexItem, .sapUiFormElement')
        ?.querySelector('input, textarea');
      if (field) return field;
    }

    return null;
  }

  function clickButtonByText(text) {
    const want = normalize(text);
    if (!want) return { ok: false, error: 'Missing button text' };

    const candidates = Array.from(
      document.querySelectorAll('button, [role=button], .sapMBtn, .sapMBtnInner, .sapMDialogButton')
    );
    for (const el of candidates) {
      const label = normalize(
        el.getAttribute('aria-label') || el.getAttribute('title') || cellText(el)
      );
      if (!label || !label.includes(want)) continue;

      const target = el.closest('button, [role=button], .sapMBtn') || el;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      return { ok: true, action: 'CLICK_TEXT_BUTTON', matched: cellText(target) || text };
    }

    return { ok: false, error: `Button not found: ${text}` };
  }

  function setFilterValue(label, value) {
    const input = pickInputByLabel(label);
    if (!input) return { ok: false, error: `Filter field not found: ${label}` };

    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    input.blur();

    return {
      ok: true,
      action: 'SET_FILTER_VALUE',
      label,
      value,
      matched: input.getAttribute('aria-label') || label,
      context: buildContext(),
    };
  }

  async function runFioriAction(action) {
    if (!action || !action.type) {
      return { ok: false, error: 'Missing action type' };
    }

    if (action.type === 'NAVIGATE_FIORI_URL') {
      if (!action.url) return { ok: false, error: 'Missing url' };
      location.href = action.url;
      return { ok: true, action: action.type, url: action.url };
    }

    if (action.type === 'SET_FILTER_VALUE') {
      return setFilterValue(action.label, action.value || '');
    }

    if (action.type === 'PRESS_GO') {
      const result = clickButtonByText(action.text || 'Go');
      if (!result.ok) return result;
      await wait(1200);
      return { ...result, context: buildContext() };
    }

    if (action.type === 'CLICK_TEXT_BUTTON') {
      const result = clickButtonByText(action.text || '');
      if (!result.ok) return result;
      await wait(600);
      return { ...result, context: buildContext() };
    }

    return { ok: false, error: `Unsupported action type: ${action.type}` };
  }

  // --- publish on hash change / load / DOM update / user request --------
  let lastSignature = null;

  function contextSignature(ctx) {
    const headers = ctx.table?.headers || [];
    const rows = ctx.table?.rows || [];
    const previewRows = rows.slice(0, 12).map(r => r.join('|')).join('||');
    const filters = ctx.filterValues ? Object.entries(ctx.filterValues).sort() : [];
    return JSON.stringify({
      url: ctx.url,
      title: ctx.title,
      intent: ctx.intent?.raw || null,
      headings: ctx.headings || [],
      tableType: ctx.table?.type || null,
      headerCount: headers.length,
      rowCount: rows.length,
      headers,
      previewRows,
      filters,
    });
  }

  function publishIfChanged(reason) {
    const ctx = buildContext();
    const signature = contextSignature(ctx);
    if (signature === lastSignature && reason !== 'forced') return ctx;
    lastSignature = signature;
    try {
      chrome.runtime.sendMessage({ type: 'FIORI_CONTEXT', context: ctx });
    } catch (e) {
      // Extension may be reloading; ignore.
    }
    return ctx;
  }

  window.addEventListener('hashchange', () => publishIfChanged('hashchange'));
  window.addEventListener('load', () => publishIfChanged('load'));

  let publishTimer = null;
  function schedulePublish(reason) {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => publishIfChanged(reason), 500);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && (mutation.addedNodes.length || mutation.removedNodes.length)) {
        schedulePublish('dom');
        return;
      }
      if (mutation.type === 'attributes') {
        schedulePublish('dom');
        return;
      }
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-busy', 'class', 'style', 'value'],
    });
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-busy', 'class', 'style', 'value'],
      });
    }, { once: true });
  }

  // Respond to on-demand extract requests from the side panel.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'EXTRACT_FIORI_CONTEXT') {
      sendResponse(publishIfChanged('forced'));
      return true;
    }

    if (msg && msg.type === 'RUN_FIORI_ACTION') {
      runFioriAction(msg.action)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  // Kick off an initial publish shortly after idle; SAPUI5 often needs a beat.
  // Several attempts cover initial boot plus slower table/data hydration.
  setTimeout(() => publishIfChanged('initial'), 1000);
  setTimeout(() => publishIfChanged('initial2'), 2500);
  setTimeout(() => publishIfChanged('initial3'), 5000);
  setTimeout(() => publishIfChanged('initial4'), 9000);
})();
