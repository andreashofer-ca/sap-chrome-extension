// settings/settings.js — load, display, and persist provider configuration.

'use strict';

const providerRadios  = document.querySelectorAll('input[name="provider"]');
const claudeSection   = document.getElementById('claude-section');
const ollamaSection   = document.getElementById('ollama-section');
const claudeKeyInput  = document.getElementById('claude-key');
const claudeModelInput = document.getElementById('claude-model');
const ollamaEndInput  = document.getElementById('ollama-endpoint');
const ollamaModelInput = document.getElementById('ollama-model');
const ollamaModelsList = document.getElementById('ollama-models');
const saveBtn         = document.getElementById('save-btn');
const testBtn         = document.getElementById('test-btn');
const saveStatus      = document.getElementById('save-status');
const testResult      = document.getElementById('test-result');

const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';

async function fetchOllamaModels(endpoint) {
  const resp = await fetch(`${endpoint}/api/tags`);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = await resp.json().catch(() => ({}));
  return Array.isArray(data.models)
    ? data.models.map((m) => m.name).filter(Boolean)
    : [];
}

function isCloudModelName(name) {
  return /(?:-cloud|:cloud)$/i.test(name || '');
}

function isVisionModelName(name) {
  return /(llava|moondream|vl:|:vl\b|-vl\b|vision|clip)/i.test(name || '');
}

function sortPreferredOllamaModels(models) {
  return [...models].sort((a, b) => {
    const aVision = isVisionModelName(a);
    const bVision = isVisionModelName(b);
    if (aVision !== bVision) return aVision ? 1 : -1;

    return a.localeCompare(b);
  });
}

function pickSuggestedTextModel(models, currentModel) {
  const preferred = sortPreferredOllamaModels(models);
  return preferred.find((name) => name !== currentModel && !isVisionModelName(name)) || null;
}

function renderOllamaModels(models) {
  ollamaModelsList.replaceChildren();
  sortPreferredOllamaModels(models).forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    ollamaModelsList.appendChild(option);
  });
}

function chooseOllamaModel(inputValue, models) {
  const requested = (inputValue || '').trim();
  const preferredModels = sortPreferredOllamaModels(models);

  if (requested && models.includes(requested)) {
    return { model: requested, autoSelected: false };
  }

  if ((!requested || requested === DEFAULT_OLLAMA_MODEL) && preferredModels.length > 0) {
    return { model: preferredModels[0], autoSelected: true };
  }

  return { model: requested || DEFAULT_OLLAMA_MODEL, autoSelected: false };
}

async function hydrateOllamaModels() {
  const endpoint = ollamaEndInput.value.trim() || DEFAULT_OLLAMA_ENDPOINT;

  try {
    const models = await fetchOllamaModels(endpoint);
    renderOllamaModels(models);

    const choice = chooseOllamaModel(ollamaModelInput.value, models);
    if (choice.autoSelected) {
      ollamaModelInput.value = choice.model;
    }
  } catch {
    renderOllamaModels([]);
  }
}

// ── Show / hide provider-specific sections ────────────────────

function applyProviderVisibility(which) {
  claudeSection.classList.toggle('hidden', which !== 'claude');
  ollamaSection.classList.toggle('hidden', which !== 'ollama');

  document.getElementById('opt-claude').classList.toggle('selected', which === 'claude');
  document.getElementById('opt-ollama').classList.toggle('selected', which === 'ollama');
}

providerRadios.forEach((radio) => {
  radio.addEventListener('change', () => applyProviderVisibility(radio.value));
});

// ── Load saved config ─────────────────────────────────────────

async function loadSettings() {
  const cfg = await chrome.storage.local.get(['provider', 'claude', 'ollama']);

  const which = cfg.provider || '';
  providerRadios.forEach((r) => { r.checked = r.value === which; });
  applyProviderVisibility(which);

  if (cfg.claude) {
    claudeKeyInput.value   = cfg.claude.apiKey  || '';
    claudeModelInput.value = cfg.claude.model   || '';
  }
  if (cfg.ollama) {
    ollamaEndInput.value   = cfg.ollama.endpoint || '';
    ollamaModelInput.value = cfg.ollama.model    || '';
  }

  await hydrateOllamaModels();
}

// ── Save config ───────────────────────────────────────────────

function getSelectedProvider() {
  for (const r of providerRadios) {
    if (r.checked) return r.value;
  }
  return '';
}

function flashSaved() {
  saveStatus.textContent = 'Saved ✓';
  saveStatus.classList.add('visible');
  setTimeout(() => saveStatus.classList.remove('visible'), 2200);
}

async function buildConfigFromForm() {
  const which = getSelectedProvider();
  const config = { provider: which };

  if (which === 'claude') {
    const apiKey = claudeKeyInput.value.trim().replace(/\s+/g, '');
    if (!apiKey) {
      throw new Error('No API key entered.');
    }

    config.claude = {
      apiKey,
      model: claudeModelInput.value.trim() || 'claude-haiku-4-5',
    };
  }

  if (which === 'ollama') {
    const endpoint = ollamaEndInput.value.trim() || DEFAULT_OLLAMA_ENDPOINT;
    let models = [];
    try {
      models = await fetchOllamaModels(endpoint);
    } catch { /* keep manual entry if Ollama is unreachable */ }

    const choice = chooseOllamaModel(ollamaModelInput.value, models);
    if (choice.autoSelected) {
      ollamaModelInput.value = choice.model;
    }

    config.ollama = {
      endpoint,
      model: choice.model,
    };
  }

  return config;
}

saveBtn.addEventListener('click', async () => {
  try {
    const toSave = await buildConfigFromForm();
    await chrome.storage.local.set(toSave);
    flashSaved();
  } catch (err) {
    if (getSelectedProvider() === 'claude') {
      claudeKeyInput.focus();
      claudeKeyInput.style.borderColor = '#ff453a';
      setTimeout(() => { claudeKeyInput.style.borderColor = ''; }, 1500);
    }
    showTestResult(false, err.message || 'Could not save settings.');
  }
});

// ── Test connection ───────────────────────────────────────────

testBtn.addEventListener('click', async () => {
  const which  = getSelectedProvider();
  const apiKey = claudeKeyInput.value.trim().replace(/\s+/g, '');
  const model  = claudeModelInput.value.trim() || 'claude-haiku-4-5';
  const endpoint = ollamaEndInput.value.trim() || DEFAULT_OLLAMA_ENDPOINT;

  testResult.className  = 'test-result';
  testResult.textContent = 'Testing…';
  testBtn.disabled = true;

  try {
    if (which === 'claude') {
      if (!apiKey) {
        showTestResult(false, 'No API key entered.');
        return;
      }
      const keyPreview = `${apiKey.slice(0, 14)}…${apiKey.slice(-4)}`;
      const result = await testProviderViaServiceWorker({
        provider: 'claude',
        claude: { apiKey, model },
      });
      if (result && result.ok) {
        await chrome.storage.local.set(await buildConfigFromForm());
        flashSaved();
        showTestResult(true, `OK ✓\nKey: ${keyPreview}\nModel: ${model}`);
      } else {
        showTestResult(false, `${result?.error || 'Connection failed'}\n\nKey used: ${keyPreview}\nModel: ${model}`);
      }

    } else if (which === 'ollama') {
      let models = [];
      try {
        models = await fetchOllamaModels(endpoint);
      } catch (e) {
        showTestResult(false, `Cannot reach Ollama at ${endpoint}\n${e.message}`);
        return;
      }

      renderOllamaModels(models);
      const choice = chooseOllamaModel(ollamaModelInput.value, models);
      const selectedModel = choice.model;
      if (choice.autoSelected) {
        ollamaModelInput.value = selectedModel;
      }

      const result = await testProviderViaServiceWorker({
        provider: 'ollama',
        ollama: { endpoint, model: selectedModel },
      });
      if (result && result.ok) {
        await chrome.storage.local.set(await buildConfigFromForm());
        flashSaved();
        const autoNote = choice.autoSelected ? `\nModel auto-selected: ${selectedModel}` : `\nModel: ${selectedModel}`;
        showTestResult(true, `OK ✓\nEndpoint: ${endpoint}${autoNote}`);
      } else {
        const preferred = sortPreferredOllamaModels(models);
        const available = preferred.length > 0 ? `\nAvailable models: ${preferred.slice(0, 8).join(', ')}` : '';
        const suggested = pickSuggestedTextModel(models, selectedModel);
        const suggestion = suggested ? `\nSuggested text model: ${suggested}` : '';
        showTestResult(false, `${result?.error || 'Connection failed'}\nEndpoint: ${endpoint}\nModel: ${selectedModel}${suggestion}${available}`);
      }

    } else {
      showTestResult(false, 'No provider selected.');
    }
  } finally {
    testBtn.disabled = false;
  }
});

function showTestResult(ok, text) {
  testResult.className  = `test-result ${ok ? 'pass' : 'fail'}`;
  testResult.textContent = text;
}

async function testProviderViaServiceWorker(config) {
  return chrome.runtime.sendMessage({ type: 'TEST_PROVIDER_CONFIG', config });
}

// ── Init ──────────────────────────────────────────────────────

loadSettings();

ollamaEndInput.addEventListener('blur', hydrateOllamaModels);
