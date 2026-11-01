import {
  loadSettings,
  saveSettings,
  resetSettings,
  formatFilename,
  IMAGE_FORMATS
} from '../lib/settings.js';

const FIELDS = [
  'defaultCaptureMode',
  'autoStartCapture',
  'hideFixedSticky',
  'warmupLazyLoad',
  'scrollDelayMs',
  'pdfPaperSize',
  'pdfSmartSplit',
  'pdfActiveLinks',
  'pdfHeaderUrlDate',
  'pdfDateFormat',
  'imageFormat',
  'filenameTemplate',
  'downloadSubdir',
  'autoDownload',
  'saveAsDialog',
  'fitGoogleDocs'
];

const saveBanner = document.getElementById('save-banner');
const previewEl = document.getElementById('filename-preview');
let bannerTimer = null;

function flashSaved() {
  if (bannerTimer) clearTimeout(bannerTimer);
  saveBanner.classList.remove('hidden');
  bannerTimer = setTimeout(() => {
    saveBanner.classList.add('hidden');
  }, 1600);
}

function updateFilenamePreview() {
  const tpl = document.getElementById('opt-filenameTemplate').value;
  const fmtKey = document.getElementById('opt-imageFormat').value;
  const ext = IMAGE_FORMATS[fmtKey]?.ext || 'png';
  const sampleRecord = {
    url: 'https://exemplo.com.br/relatorio-anual',
    title: 'Relatorio Anual 2026',
    createdAt: Date.now()
  };
  previewEl.textContent = formatFilename({ template: tpl, record: sampleRecord, ext });
}

function populateForm(settings) {
  for (const key of FIELDS) {
    const el = document.getElementById(`opt-${key}`);
    if (!el) continue;
    if (el.type === 'checkbox') {
      el.checked = Boolean(settings[key]);
    } else {
      el.value = String(settings[key] ?? '');
    }
  }
  updateFilenamePreview();
}

async function handleFieldChange(key, el) {
  let val;
  if (el.type === 'checkbox') {
    val = el.checked;
  } else if (el.type === 'number') {
    val = Math.max(60, Number(el.value) || 160);
  } else {
    val = el.value;
  }
  await saveSettings({ [key]: val });
  updateFilenamePreview();
  flashSaved();
}

for (const key of FIELDS) {
  const el = document.getElementById(`opt-${key}`);
  if (!el) continue;
  const evt = el.type === 'text' || el.type === 'number' ? 'input' : 'change';
  el.addEventListener(evt, () => handleFieldChange(key, el));
}

document.querySelectorAll('.token-chip').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const input = document.getElementById('opt-filenameTemplate');
    const token = btn.dataset.token;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = `${input.value.slice(0, start)}-${token}${input.value.slice(end)}`.replace(/--+/g, '-');
    await handleFieldChange('filenameTemplate', input);
    input.focus();
  });
});

document.getElementById('btn-reset-defaults').addEventListener('click', async () => {
  if (!confirm('Restaurar todas as configurações para os padrões de fábrica?')) return;
  const fresh = await resetSettings();
  populateForm(fresh);
  flashSaved();
});

(async function initOptions() {
  const settings = await loadSettings();
  populateForm(settings);
})();
