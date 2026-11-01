export const DEFAULT_SETTINGS = {
  autoStartCapture: false,
  defaultCaptureMode: 'scroll', // 'scroll' | 'cdp' | 'visible' | 'picker'
  imageFormat: 'png', // 'png' | 'jpeg' | 'webp'
  jpegQuality: 0.94,
  pdfPaperSize: 'a4', // 'full' | 'a4' | 'a4-landscape' | 'letter' | 'letter-landscape' | 'legal'
  pdfSmartSplit: true,
  pdfActiveLinks: true,
  pdfHeaderUrlDate: true,
  pdfDateFormat: 'br', // 'br' | 'iso' | 'us' | 'full' | 'none'
  filenameTemplate: 'getfullpage-{domain}-{date}-{time}',
  downloadSubdir: '',
  saveAsDialog: false,
  autoDownload: false,
  fitGoogleDocs: false,
  scrollDelayMs: 160,
  warmupLazyLoad: true,
  hideFixedSticky: true,
  maxCanvasHeight: 30000
};

export const PAPER_SIZES = {
  full: { label: 'Página Contínua Única (Sem Quebras)', widthPt: 0, heightPt: 0 },
  a4: { label: 'A4 Retrato (210 × 297 mm)', widthPt: 595.28, heightPt: 841.89 },
  'a4-landscape': { label: 'A4 Paisagem (297 × 210 mm)', widthPt: 841.89, heightPt: 595.28 },
  letter: { label: 'Carta EUA Retrato (Letter)', widthPt: 612, heightPt: 792 },
  'letter-landscape': { label: 'Carta EUA Paisagem (Letter)', widthPt: 792, heightPt: 612 },
  legal: { label: 'Ofício Retrato (Legal)', widthPt: 612, heightPt: 1008 }
};

export const IMAGE_FORMATS = {
  png: { mime: 'image/png', ext: 'png', label: 'PNG (Sem perdas)' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG (Compactado)' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP (Alta eficiência)' }
};

export async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get('gfp_settings');
    return { ...DEFAULT_SETTINGS, ...(stored.gfp_settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(partial) {
  const current = await loadSettings();
  const updated = { ...current, ...partial };
  await chrome.storage.local.set({ gfp_settings: updated });
  return updated;
}

export async function resetSettings() {
  await chrome.storage.local.set({ gfp_settings: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}

export function formatCaptureDate(dateInput = Date.now(), fmt = 'br') {
  if (fmt === 'none') return '';
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());

  switch (fmt) {
    case 'iso':
      return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
    case 'us':
      return `${MM}/${dd}/${yyyy} ${hh}:${mm}`;
    case 'full':
      return d.toLocaleString('pt-BR', {
        dateStyle: 'long',
        timeStyle: 'short'
      });
    case 'br':
    default:
      return `${dd}/${MM}/${yyyy} ${hh}:${mm}`;
  }
}

export function sanitizePathSegment(str, maxLen = 90) {
  return String(str || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'capture';
}

export function sanitizeSubdirectory(dir) {
  if (!dir) return '';
  return String(dir)
    .trim()
    .replace(/^[A-Za-z]:[/\\]/, '')
    .replace(/\\/g, '/')
    .replace(/\.\.+/g, '')
    .replace(/[^a-zA-Z0-9\-_/ ]+/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

export function formatFilename({ template, record, ext, sliceIndex = 0, totalSlices = 1 }) {
  const tpl = (template || DEFAULT_SETTINGS.filenameTemplate).trim() || DEFAULT_SETTINGS.filenameTemplate;
  const d = record?.createdAt ? new Date(record.createdAt) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;

  let domain = 'page';
  let pathPart = '';
  const rawUrl = record?.url || '';
  try {
    const parsed = new URL(rawUrl);
    domain = parsed.hostname.replace(/^www\./, '') || 'page';
    pathPart = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'index';
  } catch {
    domain = sanitizePathSegment(rawUrl, 40);
  }

  const tokens = {
    url: sanitizePathSegment(rawUrl.replace(/^https?:\/\//, ''), 70),
    domain: sanitizePathSegment(domain, 50),
    path: sanitizePathSegment(pathPart, 50),
    title: sanitizePathSegment(record?.title || domain, 60),
    date: dateStr,
    time: timeStr,
    timestamp: String(d.getTime())
  };

  let base = tpl.replace(/\{([a-zA-Z0-9_:-]+)\}/g, (_, token) => {
    if (token.startsWith('date:')) {
      return dateStr;
    }
    return tokens[token] ?? token;
  });

  base = sanitizePathSegment(base, 140);
  if (totalSlices > 1) {
    base += `-part-${sliceIndex + 1}`;
  }
  const cleanExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  return `${base}${cleanExt}`;
}
