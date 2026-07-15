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

function clampDefault(value) {
  return Math.max(0, Math.min(SQZ.MAX_WIDTH, Math.round(Number(value)) || 0));
}

function formState() {
  return {
    theme: document.querySelector('input[name="theme"]:checked')?.value ?? 'auto',
    defaultLeft: clampDefault($('#defaultLeft').value),
    defaultRight: clampDefault($('#defaultRight').value),
    showReadout: $('#showReadout').checked,
    colorLight: $('#colorLight').value,
    colorDark: $('#colorDark').value,
  };
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
  applyPageTheme(s.theme);
  updatePreview();
}

// Our own saves must not re-render the form (that would stomp an edit in
// progress). Matched by content, not by count: a save that changes nothing
// fires NO onChanged event at all, so a pending-write counter would leak
// and swallow the next genuine remote change. Same idiom as content/index.js.
const echoes = new Set(); // JSON stamps of our own writes

async function saveSettings() {
  const settings = formState();
  $('#defaultLeft').value = settings.defaultLeft; // reflect clamping
  $('#defaultRight').value = settings.defaultRight;
  applyPageTheme(settings.theme);
  updatePreview();
  const stamp = JSON.stringify(settings);
  echoes.add(stamp);
  if (echoes.size > 16) echoes.delete(echoes.values().next().value);
  try {
    await chrome.storage.sync.set({ [SQZ.SETTINGS_KEY]: settings });
  } catch {
    // Write throttled/failed — resync the form to what storage really holds.
    echoes.delete(stamp);
    loadSettings();
  }
}

const form = $('#settingsForm');
form.addEventListener('change', saveSettings);
form.addEventListener('input', updatePreview); // live while picking colors

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
  const stamp = JSON.stringify(changes[SQZ.SETTINGS_KEY].newValue);
  if (echoes.delete(stamp)) return; // our own save; the form is already current
  loadSettings();
});

loadSettings();
loadShortcut();
renderModKeys();
