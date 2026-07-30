// Options page. Settings live in chrome.storage.sync. Per-page records live
// in chrome.storage.local and are managed automatically (silently capped to
// the most recent SQZ.MAX_PAGES by the service worker) — there is no memory
// UI. Save-on-change; the tint hex readouts update live on every input;
// storage changes from elsewhere re-render the page.
const $ = (sel) => document.querySelector(sel);

const scheme = matchMedia('(prefers-color-scheme: dark)');
let currentTheme = 'auto';

const resolvedDark = (theme) => theme === 'dark' || (theme === 'auto' && scheme.matches);

function applyPageTheme(theme) {
  currentTheme = theme;
  document.documentElement.dataset.theme = resolvedDark(theme) ? 'dark' : 'light';
}
scheme.addEventListener('change', () => applyPageTheme(currentTheme));

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
  row.classList.toggle('invalid', !ok);
  input.setAttribute('aria-invalid', String(!ok));
}

// First-match-wins makes order meaningful, so rows can be moved, not just
// added and removed. Every mutation funnels through saveSettings(), which
// reads the rows back in DOM order.
function moveRule(row, dir) {
  const sibling = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  if (dir < 0) sibling.before(row);
  else sibling.after(row);
  syncMoveButtons();
  saveSettings();
}

function syncMoveButtons() {
  const rows = [...document.querySelectorAll('#rules .rule')];
  rows.forEach((row, i) => {
    row.querySelector('.rule-up').disabled = i === 0;
    row.querySelector('.rule-down').disabled = i === rows.length - 1;
  });
}

function ruleRow(rule) {
  const row = document.createElement('div');
  row.className = 'rule';
  row.innerHTML = `
    <input type="text" class="rule-pattern" spellcheck="false" autocomplete="off"
           placeholder="https://www\\.example\\.com/articles" aria-label="URL regex">
    <input type="number" class="rule-left" min="0" step="5"
           aria-label="Left width in px">
    <input type="number" class="rule-right" min="0" step="5"
           aria-label="Right width in px">
    <span class="rule-actions">
      <button type="button" class="rule-up" title="Move up" aria-label="Move rule up">↑</button>
      <button type="button" class="rule-down" title="Move down" aria-label="Move rule down">↓</button>
      <button type="button" class="rule-remove" title="Remove rule" aria-label="Remove rule">✕</button>
    </span>
    <span class="rule-error">INVALID REGULAR EXPRESSION — THIS RULE IS IGNORED.</span>`;
  row.querySelector('.rule-pattern').value = rule.pattern ?? '';
  row.querySelector('.rule-left').value = SQZ.clampDefault(rule.left);
  row.querySelector('.rule-right').value = SQZ.clampDefault(rule.right);
  row.querySelector('.rule-up').addEventListener('click', () => moveRule(row, -1));
  row.querySelector('.rule-down').addEventListener('click', () => moveRule(row, +1));
  row.querySelector('.rule-remove').addEventListener('click', () => {
    row.remove();
    syncMoveButtons();
    saveSettings();
  });
  markValidity(row);
  return row;
}

function renderRules(rules) {
  const box = $('#rules');
  box.textContent = '';
  for (const rule of Array.isArray(rules) ? rules : []) box.append(ruleRow(rule));
  syncMoveButtons();
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

// The hidden native color inputs remain the form's value holders; the row
// chips, hex readouts and the open editor all mirror them.
function syncTints() {
  const light = $('#colorLight').value;
  const dark = $('#colorDark').value;
  $('#colorLightHex').textContent = light;
  $('#colorDarkHex').textContent = dark;
  $('#tintChipLight').style.background = light;
  $('#tintChipDark').style.background = dark;
  refreshTintEditor();
}

// ---- tint editor ----
// A poster-styled picker: preset swatches, a hex field, and the system
// dialog as the escape hatch. It only ever writes through the hidden
// native inputs, so every change rides the normal save-on-change path.
const TINT_PRESETS = {
  // Neutrals first, then warm papers, cool blues, greens, pinks, violet.
  light: [
    '#eef0f3', '#ffffff', '#f7f8fa', '#e9ecf1', '#e5e5e5', '#dcdcdc',
    '#f6f1e6', '#f2e8da', '#eee0c9', '#e7edf4', '#dfe8f2', '#d8e4ee',
    '#e6efe8', '#dcebe2', '#f4e9ec', '#ece6f4',
  ],
  dark: [
    '#1d2126', '#000000', '#0b0d10', '#101014', '#14181f', '#191d24',
    '#1a1a1a', '#222222', '#262626', '#221a14', '#262016', '#14201e',
    '#16241c', '#1c1626', '#201420', '#24141a',
  ],
};
let tintSide = null; // 'light' | 'dark' | null = editor closed

const tintInput = (side) => (side === 'light' ? $('#colorLight') : $('#colorDark'));

function applyTint(hex) {
  const input = tintInput(tintSide);
  input.value = hex;
  input.dispatchEvent(new Event('change', { bubbles: true })); // -> saveSettings
}

function refreshTintEditor() {
  for (const btn of document.querySelectorAll('.tint-open')) {
    btn.setAttribute('aria-expanded', String(btn.dataset.side === tintSide));
  }
  const editor = $('#tintEditor');
  editor.hidden = !tintSide;
  if (!tintSide) return;
  $('#tintEditorLabel').textContent = tintSide === 'light' ? 'DAY TINT' : 'NIGHT TINT';
  const current = tintInput(tintSide).value;
  const box = $('#tintSwatches');
  box.textContent = '';
  for (const hex of TINT_PRESETS[tintSide]) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = hex === current ? 'tint-swatch active' : 'tint-swatch';
    swatch.style.setProperty('--swatch', hex);
    swatch.append(document.createElement('i'), hex);
    swatch.addEventListener('click', () => applyTint(hex));
    box.append(swatch);
  }
  if (document.activeElement !== $('#tintHex')) $('#tintHex').value = current;
}

for (const btn of document.querySelectorAll('.tint-open')) {
  btn.addEventListener('click', () => {
    tintSide = tintSide === btn.dataset.side ? null : btn.dataset.side;
    refreshTintEditor();
  });
}
$('#tintClose').addEventListener('click', () => {
  tintSide = null;
  refreshTintEditor();
});
$('#tintCustom').addEventListener('click', () => tintInput(tintSide).click());
$('#tintHex').addEventListener('change', () => {
  let hex = $('#tintHex').value.trim().toLowerCase();
  if (!hex.startsWith('#')) hex = '#' + hex;
  if (/^#[0-9a-f]{6}$/.test(hex)) applyTint(hex);
  else $('#tintHex').value = tintInput(tintSide).value; // revert, keep the stored tint
});

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
  syncTints();
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
  syncTints();
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
form.addEventListener('input', syncTints); // live while picking colors

// The giant width numbers select as a block — every focus or click selects
// the whole number, so typing replaces it outright and no caret ever blinks
// (the caret is transparent and ::selection inverts the band's ink).
for (const el of [$('#defaultLeft'), $('#defaultRight')]) {
  el.addEventListener('focus', () => el.select());
  el.addEventListener('click', () => el.select());
}

// New rules start from the current global defaults; nothing is saved until
// the pattern is committed (blank patterns never reach storage).
$('#addRule').addEventListener('click', () => {
  const row = ruleRow({
    pattern: '',
    left: SQZ.clampDefault($('#defaultLeft').value),
    right: SQZ.clampDefault($('#defaultRight').value),
  });
  $('#rules').append(row);
  syncMoveButtons();
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
  const box = $('#shortcutKeys');
  box.textContent = '';
  if (!shortcut) {
    const none = document.createElement('div');
    none.className = 'keycap-none';
    none.textContent = 'NOT SET';
    box.append(none);
    return;
  }
  // Chrome formats shortcuts as "Alt+Shift+S" or, on macOS, as a bare
  // symbol run like "⌥⇧S" — split either way into one keycap per key.
  const parts = shortcut.includes('+')
    ? shortcut.split('+')
    : (shortcut.match(/[⌘⌥⇧⌃]|[^⌘⌥⇧⌃]+/gu) ?? [shortcut]);
  for (const part of parts) {
    const key = document.createElement('div');
    key.className = part.length > 1 ? 'keycap wide' : 'keycap';
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

$('#openIssue').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://github.com/MarksonChen/pillarbox/issues/new' });
});

// Web Store review link. REVIEW_URL pins the listing once published; until
// it is set, the runtime id resolves correctly for store installs.
const REVIEW_URL = '';
$('#openReview').addEventListener('click', () => {
  chrome.tabs.create({
    url: REVIEW_URL || `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`,
  });
});

// Gesture legend: any modifier key means "both sides" (mirrored drag,
// reset). Show this platform's modifiers, slash-run style.
function renderModKeys() {
  const mac = navigator.platform.startsWith('Mac');
  const run = (mac ? ['⇧', '⌃', '⌥', '⌘'] : ['SHIFT', 'CTRL', 'ALT']).join('/');
  for (const box of document.querySelectorAll('.modkeys')) box.textContent = run;
}

// The bottom ticker: one phrase repeated far past the canvas width, twice —
// the CSS loop slides by exactly one of the two identical halves.
function renderTicker() {
  const run = Array(10).fill('ADJUST → IT SAVES → CLOSE THE TAB').join(' → ') + ' → ';
  for (const half of document.querySelectorAll('.ticker-inner span')) half.textContent = run;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !(SQZ.SETTINGS_KEY in changes)) return;
  if (echoes.own(changes[SQZ.SETTINGS_KEY].newValue)) return; // our own save
  loadSettings();
});

// Dogfood: options.html loads the real content scripts, so the pillars are
// live on this page too. Seed the page record on the first visit — panels
// on at 400×400; index.js picks the write up through storage.onChanged and
// enables itself. From then on the record is the user's, like on any page:
// resize, collapse or toggle off here and it sticks.
async function seedOwnPanels() {
  const key = SQZ.pageKey(location.href);
  const existing = await chrome.storage.local.get(key);
  if (key in existing) return;
  await chrome.storage.local.set({ [key]: { on: true, left: 400, right: 400, t: Date.now() } });
}

loadSettings();
loadShortcut();
renderModKeys();
renderTicker();
seedOwnPanels();
