import {
  getCaptureRecord,
  updateCaptureRecord,
  listCaptureRecords,
  deleteCaptureRecords
} from '../lib/db.js';
import {
  loadSettings,
  IMAGE_FORMATS,
  formatFilename,
  sanitizeSubdirectory
} from '../lib/settings.js';
import {
  loadImage,
  blobToDataURL,
  copyCanvasOrImageToClipboard
} from '../lib/stitcher.js';
import { exportCaptureToPDF } from '../lib/pdf-exporter.js';
import { ProScreenshotEditor } from '../editor/editor.js';

const sectionViewer = document.getElementById('section-viewer');
const sectionHistory = document.getElementById('section-history');
const canvasStage = document.getElementById('canvas-stage');
const editorToolbar = document.getElementById('editor-toolbar');
const captureMeta = document.getElementById('capture-meta');
const captureActions = document.getElementById('capture-actions');

const metaUrl = document.getElementById('meta-url');
const metaDims = document.getElementById('meta-dims');
const metaLinks = document.getElementById('meta-links');

const btnBackView = document.getElementById('btn-back-view');
const btnToggleEditor = document.getElementById('btn-toggle-editor');
const lblToggleEditor = document.getElementById('lbl-toggle-editor');
const btnCopyClipboard = document.getElementById('btn-copy-clipboard');
const btnDownloadImg = document.getElementById('btn-download-img');
const lblDownloadImg = document.getElementById('lbl-download-img');
const btnDownloadPdf = document.getElementById('btn-download-pdf');
const btnDeleteCurrent = document.getElementById('btn-delete-current');

const btnNavHistory = document.getElementById('btn-nav-history');
const btnNavShortcuts = document.getElementById('btn-nav-shortcuts');
const btnNavOptions = document.getElementById('btn-nav-options');

const zoomControls = document.getElementById('zoom-controls');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnZoomFit = document.getElementById('btn-zoom-fit');
const btnZoomIn = document.getElementById('btn-zoom-in');
const zoomLabel = document.getElementById('zoom-label');

const toastEl = document.getElementById('toast');
const shortcutsDialog = document.getElementById('shortcuts-dialog');

// Fallback obrigatório para navegadores sem suporte nativo a HTMLDialogElement.prototype.closedBy
if (shortcutsDialog && !('closedBy' in HTMLDialogElement.prototype)) {
  shortcutsDialog.addEventListener('click', (event) => {
    if (event.target !== shortcutsDialog) return;
    const rect = shortcutsDialog.getBoundingClientRect();
    const isDialogContent =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (isDialogContent) return;
    shortcutsDialog.close();
  });
}

let currentRecord = null;
let loadedSlices = []; // Array de { img, width, height, url }
let currentSettings = null;
let editorInstance = null;
let isEditorMode = false;
let zoomFactor = 'fit'; // 'fit' ou número (ex: 1, 0.5, 1.5)
let toastTimer = null;

function showToast(message, duration = 3000) {
  if (toastTimer) clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, duration);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function loadRecordIntoViewer(recordId, startInEditor = false) {
  currentSettings = await loadSettings();
  const record = await getCaptureRecord(recordId);
  if (!record) {
    showToast('Captura não encontrada. Exibindo histórico.');
    await showHistoryView();
    return;
  }

  currentRecord = record;
  sectionHistory.classList.add('hidden');
  sectionViewer.classList.remove('hidden');
  captureMeta.classList.remove('hidden');
  captureActions.classList.remove('hidden');

  const fmtSpec = IMAGE_FORMATS[currentSettings.imageFormat] || IMAGE_FORMATS.png;
  lblDownloadImg.textContent = `Baixar ${fmtSpec.ext.toUpperCase()}`;

  metaUrl.textContent = record.url || record.title || 'Página Capturada';
  metaUrl.href = record.url || '#';
  metaDims.textContent = `${record.width} × ${record.height} px`;
  const linkCount = record.metadata?.links?.length || 0;
  metaLinks.textContent = `${linkCount} links ativos no PDF`;

  // Carrega imagens a partir dos Blobs (priorizando editedBlob na visualização se existir)
  for (const s of loadedSlices) {
    if (s.objectUrl) URL.revokeObjectURL(s.objectUrl);
  }
  loadedSlices = [];

  for (const slice of record.slices || []) {
    const objectUrl = URL.createObjectURL(slice.blob);
    const loaded = await loadImage(objectUrl);
    loadedSlices.push({ ...loaded, objectUrl });
  }

  if (startInEditor) {
    enterEditorMode();
  } else {
    await exitEditorMode(false);
  }
}

async function renderViewerStage() {
  canvasStage.innerHTML = '';
  if (currentRecord?.editedBlob) {
    const editedUrl = URL.createObjectURL(currentRecord.editedBlob);
    const { img } = await loadImage(editedUrl);
    img.dataset.editedPreview = 'true';
    canvasStage.appendChild(img);
  } else {
    for (const s of loadedSlices) {
      const img = document.createElement('img');
      img.src = s.src;
      img.alt = 'Fatia da captura';
      canvasStage.appendChild(img);
    }
  }
  applyZoom();
}

function applyZoom() {
  const targetWidth = currentRecord?.editedWidth || currentRecord?.width || 1200;
  const dpr = currentRecord?.scaleMultiplier || 1;
  const logicalW = Math.round(targetWidth / dpr);
  const availW = Math.max(360, window.innerWidth - 64);

  let effectiveCssWidth;
  if (zoomFactor === 'fit') {
    effectiveCssWidth = Math.min(logicalW, availW);
    const pct = Math.round((effectiveCssWidth / logicalW) * 100);
    zoomLabel.textContent = `${pct}%`;
  } else {
    effectiveCssWidth = Math.round(logicalW * zoomFactor);
    zoomLabel.textContent = `${Math.round(zoomFactor * 100)}%`;
  }

  canvasStage.style.width = `${effectiveCssWidth}px`;
}

function enterEditorMode() {
  if (!currentRecord || !loadedSlices.length) return;
  isEditorMode = true;
  editorToolbar.classList.remove('hidden');
  lblToggleEditor.textContent = 'Sair do Editor';
  btnBackView.classList.remove('hidden');

  editorInstance = new ProScreenshotEditor({
    containerEl: canvasStage,
    sourceImages: loadedSlices,
    record: currentRecord,
    initialState: currentRecord.editorState || null,
    onStateChange: (info) => {
      document.getElementById('btn-ed-undo').disabled = !info.canUndo;
      document.getElementById('btn-ed-redo').disabled = !info.canRedo;
      document.getElementById('btn-reset-crop').classList.toggle('hidden', !info.hasCrop);
      document.getElementById('btn-ed-del-layer').classList.toggle('hidden', !info.selectedLayerId);
    }
  });

  // Sincroniza controles de formatação com o estado salvo
  const st = editorInstance.state;
  document.getElementById('ed-frame').value = st.browserFrame || 'none';
  document.getElementById('ed-padding').value = String(st.padding || 0);
  document.getElementById('ed-pad-color').value = st.paddingColor || '#1e293b';
  document.getElementById('ed-radius').value = String(st.borderRadius || 0);
  applyZoom();
}

async function exitEditorMode(saveChanges = true) {
  if (isEditorMode && editorInstance && saveChanges) {
    await saveEditorChangesToDB();
  }
  isEditorMode = false;
  editorInstance = null;
  editorToolbar.classList.add('hidden');
  btnBackView.classList.add('hidden');
  lblToggleEditor.textContent = currentRecord?.editedBlob ? 'Editar Novamente' : 'Editar & Anotar';
  await renderViewerStage();
}

async function saveEditorChangesToDB() {
  if (!editorInstance || !currentRecord) return;
  const fmtSpec = IMAGE_FORMATS[currentSettings?.imageFormat] || IMAGE_FORMATS.png;
  const { blob, width, height } = await editorInstance.exportToBlob(fmtSpec.mime, currentSettings?.jpegQuality || 0.94);
  currentRecord = await updateCaptureRecord(currentRecord.id, {
    editedBlob: blob,
    editedWidth: width,
    editedHeight: height,
    editorState: structuredClone(editorInstance.state)
  });
  showToast('✓ Edições salvas automaticamente na captura!');
}

async function getExportableImagesForCurrentState() {
  if (isEditorMode && editorInstance) {
    const exportCanvas = editorInstance.getExportCanvas();
    return [{ canvas: exportCanvas, width: exportCanvas.width, height: exportCanvas.height }];
  }
  if (currentRecord?.editedBlob) {
    const url = URL.createObjectURL(currentRecord.editedBlob);
    const loaded = await loadImage(url);
    return [loaded];
  }
  return loadedSlices;
}

async function handleDownloadImage() {
  if (!currentRecord) return;
  currentSettings = await loadSettings();
  const fmtSpec = IMAGE_FORMATS[currentSettings.imageFormat] || IMAGE_FORMATS.png;
  const subdir = sanitizeSubdirectory(currentSettings.downloadSubdir);

  if (isEditorMode && editorInstance) {
    await saveEditorChangesToDB();
  }

  let blobsToDownload = [];
  if (currentRecord.editedBlob) {
    // Converte para o formato escolhido caso necessário
    const imgs = await getExportableImagesForCurrentState();
    const c = document.createElement('canvas');
    c.width = imgs[0].width;
    c.height = imgs[0].height;
    c.getContext('2d').drawImage(imgs[0].canvas || imgs[0].img, 0, 0);
    const dataUrl = c.toDataURL(fmtSpec.mime, currentSettings.jpegQuality || 0.94);
    blobsToDownload = [{ dataUrl, index: 0 }];
  } else {
    for (let i = 0; i < loadedSlices.length; i++) {
      const s = loadedSlices[i];
      const c = document.createElement('canvas');
      c.width = s.width;
      c.height = s.height;
      c.getContext('2d').drawImage(s.img, 0, 0);
      const dataUrl = c.toDataURL(fmtSpec.mime, currentSettings.jpegQuality || 0.94);
      blobsToDownload.push({ dataUrl, index: i });
    }
  }

  for (const item of blobsToDownload) {
    const fname = formatFilename({
      template: currentSettings.filenameTemplate,
      record: currentRecord,
      ext: fmtSpec.ext,
      sliceIndex: item.index,
      totalSlices: blobsToDownload.length
    });
    const fullPath = subdir ? `${subdir}/${fname}` : fname;
    await chrome.downloads.download({
      url: item.dataUrl,
      filename: fullPath,
      conflictAction: 'uniquify',
      saveAs: Boolean(currentSettings.saveAsDialog) && blobsToDownload.length === 1
    });
  }

  showToast(`✓ Imagem (${fmtSpec.ext.toUpperCase()}) exportada com sucesso!`);
}

async function handleDownloadPDF() {
  if (!currentRecord) return;
  btnDownloadPdf.disabled = true;
  const origLabel = btnDownloadPdf.querySelector('span').textContent;

  try {
    currentSettings = await loadSettings();
    if (isEditorMode && editorInstance) {
      await saveEditorChangesToDB();
    }

    const images = await getExportableImagesForCurrentState();
    const pdfBlob = await exportCaptureToPDF({
      images,
      record: currentRecord,
      settings: currentSettings,
      onProgress: (p) => {
        btnDownloadPdf.querySelector('span').textContent = `PDF ${Math.round(p * 100)}%...`;
      }
    });

    const dataUrl = await blobToDataURL(pdfBlob);
    const subdir = sanitizeSubdirectory(currentSettings.downloadSubdir);
    const fname = formatFilename({
      template: currentSettings.filenameTemplate,
      record: currentRecord,
      ext: 'pdf'
    });
    const fullPath = subdir ? `${subdir}/${fname}` : fname;

    await chrome.downloads.download({
      url: dataUrl,
      filename: fullPath,
      conflictAction: 'uniquify',
      saveAs: Boolean(currentSettings.saveAsDialog)
    });

    showToast('✓ PDF exportado com Smart Page Splitting e Links Ativos!');
  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    showToast(`Erro ao exportar PDF: ${err?.message || String(err)}`, 4500);
  } finally {
    btnDownloadPdf.disabled = false;
    btnDownloadPdf.querySelector('span').textContent = origLabel;
  }
}

async function handleCopyClipboard() {
  if (!currentRecord) return;
  try {
    currentSettings = await loadSettings();
    const images = await getExportableImagesForCurrentState();
    const { resized } = await copyCanvasOrImageToClipboard(images, Boolean(currentSettings.fitGoogleDocs));
    showToast(
      resized
        ? '✓ Imagem copiada para a área de transferência (ajustada para Google Docs)!'
        : '✓ Imagem copiada para a área de transferência!'
    );
  } catch (err) {
    showToast(`Não foi possível copiar: ${err?.message || String(err)}`, 4000);
  }
}

// Gerenciador de Histórico
async function showHistoryView() {
  isEditorMode = false;
  editorToolbar.classList.add('hidden');
  sectionViewer.classList.add('hidden');
  captureMeta.classList.add('hidden');
  captureActions.classList.add('hidden');
  sectionHistory.classList.remove('hidden');

  const records = await listCaptureRecords();
  if (currentRecord) {
    btnBackView.classList.remove('hidden');
  } else {
    btnBackView.classList.add('hidden');
  }

  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '';

  if (!records.length) {
    listEl.innerHTML = `<p style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted)">Nenhuma captura encontrada ainda. Clique no ícone da extensão em qualquer página para capturar!</p>`;
    return;
  }

  for (const rec of records) {
    const card = document.createElement('article');
    card.className = 'history-card';

    const previewBlob = rec.editedBlob || rec.slices?.[0]?.blob;
    const thumbUrl = previewBlob ? URL.createObjectURL(previewBlob) : '';
    const totalBytes =
      (rec.editedBlob?.size || 0) ||
      (rec.slices || []).reduce((acc, s) => acc + (s.blob?.size || 0), 0);
    const dateStr = new Date(rec.createdAt).toLocaleString('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short'
    });

    card.innerHTML = `
      <div class="history-thumb-wrap" data-open-id="${rec.id}">
        ${thumbUrl ? `<img src="${thumbUrl}" alt="Miniatura">` : ''}
        <input type="checkbox" class="history-card-check" data-id="${rec.id}">
      </div>
      <div class="history-card-body">
        <a href="?id=${encodeURIComponent(rec.id)}" class="history-card-title" title="${rec.title || rec.url}">
          ${rec.title || rec.url || 'Captura sem título'}
        </a>
        <div class="history-card-sub">
          <span>${dateStr}</span>
          <span>${rec.width}×${rec.height}px • ${formatBytes(totalBytes)}</span>
        </div>
      </div>
    `;

    card.querySelector('.history-thumb-wrap').addEventListener('click', (e) => {
      if (e.target.classList.contains('history-card-check')) return;
      window.location.search = `?id=${encodeURIComponent(rec.id)}`;
    });

    card.querySelector('.history-card-check').addEventListener('change', updateBulkSelectionState);
    listEl.appendChild(card);
  }

  updateBulkSelectionState();
}

function getCheckedHistoryIds() {
  return Array.from(document.querySelectorAll('.history-card-check:checked')).map((el) => el.dataset.id);
}

function updateBulkSelectionState() {
  const allChecks = Array.from(document.querySelectorAll('.history-card-check'));
  const checked = getCheckedHistoryIds();
  const btnBulkDl = document.getElementById('btn-bulk-download');
  const btnBulkDel = document.getElementById('btn-bulk-delete');
  const lblCount = document.getElementById('lbl-selected-count');
  const chkAll = document.getElementById('chk-select-all');

  btnBulkDl.disabled = checked.length === 0;
  btnBulkDel.disabled = checked.length === 0;
  lblCount.textContent = checked.length > 0 ? `${checked.length} selecionada(s)` : 'Selecionar tudo';
  chkAll.checked = allChecks.length > 0 && checked.length === allChecks.length;
}

// Eventos da Barra Superior e Editor
btnToggleEditor.addEventListener('click', () => {
  if (isEditorMode) {
    exitEditorMode(true);
  } else {
    enterEditorMode();
  }
});

btnBackView.addEventListener('click', () => {
  if (isEditorMode) {
    exitEditorMode(true);
  } else if (currentRecord) {
    loadRecordIntoViewer(currentRecord.id, false);
  }
});

btnDownloadImg.addEventListener('click', handleDownloadImage);
btnDownloadPdf.addEventListener('click', handleDownloadPDF);
btnCopyClipboard.addEventListener('click', handleCopyClipboard);

btnDeleteCurrent.addEventListener('click', async () => {
  if (!currentRecord) return;
  if (!confirm('Tem certeza de que deseja excluir esta captura?')) return;
  await deleteCaptureRecords([currentRecord.id]);
  currentRecord = null;
  showToast('Captura excluída.');
  await showHistoryView();
});

btnNavHistory.addEventListener('click', () => showHistoryView());
btnNavShortcuts.addEventListener('click', () => shortcutsDialog.showModal());
btnNavOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

// Controles de Zoom
btnZoomOut.addEventListener('click', () => {
  const cur = zoomFactor === 'fit' ? 0.75 : zoomFactor;
  zoomFactor = Math.max(0.2, Number((cur - 0.2).toFixed(2)));
  applyZoom();
});

btnZoomIn.addEventListener('click', () => {
  const cur = zoomFactor === 'fit' ? 1 : zoomFactor;
  zoomFactor = Math.min(3, Number((cur + 0.25).toFixed(2)));
  applyZoom();
});

btnZoomFit.addEventListener('click', () => {
  zoomFactor = zoomFactor === 'fit' ? 1 : 'fit';
  btnZoomFit.textContent = zoomFactor === 'fit' ? '100%' : 'Ajustar';
  applyZoom();
});

window.addEventListener('resize', () => {
  if (zoomFactor === 'fit') applyZoom();
});

// Eventos da Barra do Editor Pro
document.querySelectorAll('#editor-toolbar [data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#editor-toolbar [data-tool]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    editorInstance?.setTool(btn.dataset.tool);
  });
});

document.getElementById('ed-color').addEventListener('input', (e) => {
  editorInstance?.setStyleOptions({ color: e.target.value });
});

document.getElementById('ed-stroke').addEventListener('change', (e) => {
  editorInstance?.setStyleOptions({ strokeWidth: Number(e.target.value) });
});

document.getElementById('ed-fill').addEventListener('change', (e) => {
  editorInstance?.setStyleOptions({ fillShape: e.target.checked });
});

document.getElementById('ed-frame').addEventListener('change', (e) => {
  editorInstance?.setFormatting({ browserFrame: e.target.value });
});

document.getElementById('ed-padding').addEventListener('change', (e) => {
  editorInstance?.setFormatting({ padding: Number(e.target.value) });
});

document.getElementById('ed-pad-color').addEventListener('input', (e) => {
  editorInstance?.setFormatting({ paddingColor: e.target.value });
});

document.getElementById('ed-radius').addEventListener('change', (e) => {
  editorInstance?.setFormatting({ borderRadius: Number(e.target.value) });
});

document.getElementById('btn-reset-crop').addEventListener('click', () => {
  editorInstance?.resetCrop();
});

document.getElementById('btn-ed-undo').addEventListener('click', () => editorInstance?.undo());
document.getElementById('btn-ed-redo').addEventListener('click', () => editorInstance?.redo());
document.getElementById('btn-ed-del-layer').addEventListener('click', () => editorInstance?.deleteSelectedLayer());
document.getElementById('btn-ed-clear').addEventListener('click', () => editorInstance?.clearAllEdits());
document.getElementById('btn-ed-save').addEventListener('click', () => saveEditorChangesToDB());

// Eventos em lote do Histórico
document.getElementById('chk-select-all').addEventListener('change', (e) => {
  const checked = e.target.checked;
  document.querySelectorAll('.history-card-check').forEach((c) => {
    c.checked = checked;
  });
  updateBulkSelectionState();
});

document.getElementById('btn-bulk-delete').addEventListener('click', async () => {
  const ids = getCheckedHistoryIds();
  if (!ids.length) return;
  if (!confirm(`Excluir ${ids.length} captura(s) permanentemente?`)) return;
  await deleteCaptureRecords(ids);
  showToast(`${ids.length} captura(s) removida(s).`);
  await showHistoryView();
});

document.getElementById('btn-bulk-download').addEventListener('click', async () => {
  const ids = getCheckedHistoryIds();
  if (!ids.length) return;
  const settings = await loadSettings();
  const fmtSpec = IMAGE_FORMATS[settings.imageFormat] || IMAGE_FORMATS.png;
  const subdir = sanitizeSubdirectory(settings.downloadSubdir);

  for (const id of ids) {
    const rec = await getCaptureRecord(id);
    if (!rec) continue;
    const blob = rec.editedBlob || rec.slices?.[0]?.blob;
    if (!blob) continue;
    const dataUrl = await blobToDataURL(blob);
    const fname = formatFilename({
      template: settings.filenameTemplate,
      record: rec,
      ext: fmtSpec.ext
    });
    const fullPath = subdir ? `${subdir}/${fname}` : fname;
    await chrome.downloads.download({
      url: dataUrl,
      filename: fullPath,
      conflictAction: 'uniquify',
      saveAs: false
    });
  }
  showToast(`${ids.length} arquivo(s) baixado(s)!`);
});

// Atalhos globais de teclado no Viewer/Editor
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    handleDownloadImage();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    handleCopyClipboard();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    if (isEditorMode) exitEditorMode(true);
    else enterEditorMode();
    return;
  }
  if (isEditorMode && editorInstance) {
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      editorInstance.undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      editorInstance.redo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      editorInstance.deleteSelectedLayer();
    }
  }
});

(async function init() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const edit = params.get('edit') === '1';

  if (id) {
    await loadRecordIntoViewer(id, edit);
  } else {
    await showHistoryView();
  }
})();
