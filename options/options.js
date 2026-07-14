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

let selfWrites = 0; // our own saves must not re-render (stomps in-progress edits)

async function saveSettings() {
  const settings = formState();
  $('#defaultLeft').value = settings.defaultLeft; // reflect clamping
  $('#defaultRight').value = settings.defaultRight;
  applyPageTheme(settings.theme);
  updatePreview();
  selfWrites++;
  try {
    await chrome.storage.sync.set({ [SQZ.SETTINGS_KEY]: settings });
  } catch {
    // Write throttled/failed — resync the form to what storage really holds.
    selfWrites--;
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !(SQZ.SETTINGS_KEY in changes)) return;
  if (selfWrites > 0) {
    selfWrites--; // our own save; the form is already current
    return;
  }
  loadSettings();
});

loadSettings();
loadShortcut();
