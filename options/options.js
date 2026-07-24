// Options page. Settings live in chrome.storage.sync. Per-page records live
// in chrome.storage.local and are managed automatically (silently capped to
// the most recent SQZ.MAX_PAGES by the service worker) — there is no memory
// UI. Save-on-change; the preview updates live on every input; storage
// changes from elsewhere re-render the page.
const $ = (sel) => document.querySelector(sel);

const scheme = matchMedia('(prefers-color-scheme: dark)');
let currentTheme = 'auto';

const resolvedDark = (theme) => theme === 'dark' || (theme === 'auto' && scheme.matches);

function applyPageTheme(theme) {
  currentTheme = theme;
  document.documentElement.dataset.theme = resolvedDark(theme) ? 'dark' : 'light';
}
scheme.addEventListener('change', () => {
  applyPageTheme(currentTheme);
  updatePreview();
});

function formState() {
  return {
    theme: document.querySelector('input[name="theme"]:checked')?.value ?? 'auto',
    defaultLeft: SQZ.clampDefault($('#defaultLeft').value),
    defaultRight: SQZ.clampDefault($('#defaultRight').value),
    showReadout: $('#showReadout').checked,
    colorLight: $('#colorLight').value,
    colorDark: $('#colorDark').value,
    rules: rulesFromForm(),
  };
}

// ---- per-URL default-width rules ----
// Each row is one {pattern, left, right}. Rows live in the form, so edits
// ride the same save-on-change path as every other field. A row with an
// empty pattern stays in the UI but is not saved; an invalid regex is saved
// (nothing typed is ever thrown away) but flagged here and skipped by the
// content script at match time.
function markValidity(row) {
  const input = row.querySelector('.rule-pattern');
  let ok = true;
  if (input.value) {
    try { new RegExp(input.value); } catch { ok = false; }
  }
  input.classList.toggle('invalid', !ok);
}

function ruleRow(rule) {
  const row = document.createElement('div');
  row.className = 'rule';
  row.innerHTML = `
    <input type="text" class="rule-pattern" spellcheck="false" autocomplete="off"
           placeholder="https://www\\.example\\.com/articles" aria-label="URL regex">
    <input type="number" class="rule-left" min="0" max="${SQZ.MAX_WIDTH}" step="5"
           aria-label="Left width">
    <span class="unit">×</span>
    <input type="number" class="rule-right" min="0" max="${SQZ.MAX_WIDTH}" step="5"
           aria-label="Right width">
    <span class="unit">px</span>
    <button type="button" class="ghost rule-remove" title="Remove rule">✕</button>`;
  row.querySelector('.rule-pattern').value = rule.pattern ?? '';
  row.querySelector('.rule-left').value = SQZ.clampDefault(rule.left);
  row.querySelector('.rule-right').value = SQZ.clampDefault(rule.right);
  row.querySelector('.rule-remove').addEventListener('click', () => {
    row.remove();
    saveSettings();
  });
  markValidity(row);
  return row;
}

function renderRules(rules) {
  const box = $('#rules');
  box.textContent = '';
  for (const rule of Array.isArray(rules) ? rules : []) box.append(ruleRow(rule));
}

function rulesFromForm() {
  return [...document.querySelectorAll('#rules .rule')].flatMap((row) => {
    markValidity(row);
    const pattern = row.querySelector('.rule-pattern').value.trim();
    if (!pattern) return [];
    return [{
      pattern,
      left: SQZ.clampDefault(row.querySelector('.rule-left').value),
      right: SQZ.clampDefault(row.querySelector('.rule-right').value),
    }];
  });
}

// Mini mock of a squeezed page: panel colors follow the selected theme,
// panel widths are proportional to the defaults on a nominal 1440px window.
function updatePreview() {
  const s = formState();
  const dark = resolvedDark(s.theme);
  const panel = dark ? s.colorDark : s.colorLight;
  const pct = (px) => `${Math.min(42, (px / 1440) * 100)}%`;
  $('#pvLeft').style.background = panel;
  $('#pvRight').style.background = panel;
  $('#pvLeft').style.width = pct(s.defaultLeft);
  $('#pvRight').style.width = pct(s.defaultRight);
  const pv = document.querySelector('.pv-page');
  pv.style.setProperty('--pv-page-bg', dark ? '#0e1116' : '#ffffff');
  pv.style.setProperty('--pv-line', dark ? '#232936' : '#e6e9ef');
  $('#colorLightHex').textContent = s.colorLight;
  $('#colorDarkHex').textContent = s.colorDark;
}

async function loadSettings() {
  const raw = await chrome.storage.sync.get(SQZ.SETTINGS_KEY);
  const s = SQZ.mergeSettings(raw[SQZ.SETTINGS_KEY]);
  const radio = document.querySelector(`input[name="theme"][value="${s.theme}"]`);
  if (radio) radio.checked = true;
  $('#defaultLeft').value = s.defaultLeft;
  $('#defaultRight').value = s.defaultRight;
  $('#showReadout').checked = s.showReadout === true;
  $('#colorLight').value = SQZ.sanitizeColor(s.colorLight, SQZ.DEFAULT_SETTINGS.colorLight);
  $('#colorDark').value = SQZ.sanitizeColor(s.colorDark, SQZ.DEFAULT_SETTINGS.colorDark);
  renderRules(s.rules);
  applyPageTheme(s.theme);
  updatePreview();
}

// Our own saves must not re-render the form (that would stomp an edit in
// progress); see SQZ.makeEchoes for why matching is by content, not count.
const echoes = SQZ.makeEchoes();

async function saveSettings() {
  const settings = formState();
  $('#defaultLeft').value = settings.defaultLeft; // reflect clamping
  $('#defaultRight').value = settings.defaultRight;
  for (const row of document.querySelectorAll('#rules .rule')) {
    for (const cls of ['.rule-left', '.rule-right']) {
      const input = row.querySelector(cls);
      input.value = SQZ.clampDefault(input.value);
    }
  }
  applyPageTheme(settings.theme);
  updatePreview();
  const stamp = echoes.add(settings);
  try {
    await chrome.storage.sync.set({ [SQZ.SETTINGS_KEY]: settings });
  } catch {
    // Write throttled/failed — resync the form to what storage really holds.
    echoes.drop(stamp);
    loadSettings();
  }
}

const form = $('#settingsForm');
form.addEventListener('change', saveSettings);
form.addEventListener('input', updatePreview); // live while picking colors

// New rules start from the current global defaults; nothing is saved until
// the pattern is committed (blank patterns never reach storage).
$('#addRule').addEventListener('click', () => {
  const row = ruleRow({
    pattern: '',
    left: SQZ.clampDefault($('#defaultLeft').value),
    right: SQZ.clampDefault($('#defaultRight').value),
  });
  $('#rules').append(row);
  row.querySelector('.rule-pattern').focus();
});

$('#resetColors').addEventListener('click', () => {
  $('#colorLight').value = SQZ.DEFAULT_SETTINGS.colorLight;
  $('#colorDark').value = SQZ.DEFAULT_SETTINGS.colorDark;
  saveSettings();
});

// Chrome has no API for extensions to SET command shortcuts, only to read
// them — so show the live binding and link to Chrome's editor.
function renderShortcut(shortcut) {
  const box = $('#shortcutValue');
  box.textContent = '';
  if (!shortcut) {
    box.textContent = 'Not set';
    return;
  }
  // Chrome formats shortcuts as "Alt+Shift+S" or, on macOS, as a bare
  // symbol run like "⌥⇧S" — split either way into one keycap per key.
  const parts = shortcut.includes('+')
    ? shortcut.split('+')
    : (shortcut.match(/[⌘⌥⇧⌃]|[^⌘⌥⇧⌃]+/gu) ?? [shortcut]);
  for (const part of parts) {
    const key = document.createElement('kbd');
    key.textContent = part;
    box.append(key);
  }
}

async function loadShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    renderShortcut(commands.find((c) => c.name === '_execute_action')?.shortcut);
  } catch {
    renderShortcut('Alt+Shift+S');
  }
}

$('#openShortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Gesture legend: any modifier key mirrors a drag to the other sidebar.
// Show this platform's modifiers as keycaps.
function renderModKeys() {
  const mac = navigator.platform.startsWith('Mac');
  const box = $('#modKeys');
  for (const mod of mac ? ['⇧', '⌃', '⌥', '⌘'] : ['Shift', 'Ctrl', 'Alt']) {
    const key = document.createElement('kbd');
    key.textContent = mod;
    box.append(key);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !(SQZ.SETTINGS_KEY in changes)) return;
  if (echoes.own(changes[SQZ.SETTINGS_KEY].newValue)) return; // our own save
  loadSettings();
});

loadSettings();
loadShortcut();
renderModKeys();
