import { saveCaptureRecord } from '../lib/db.js';
import {
  loadSettings,
  IMAGE_FORMATS,
  formatFilename,
  sanitizeSubdirectory
} from '../lib/settings.js';

// Mantém a sessão de costura ativa em memória durante a execução da captura,
// sincronizando o status em chrome.storage.session (Regra 7 e 16 de MV3).
let activeSession = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setSessionState(patch) {
  const { captureState = {} } = await chrome.storage.session.get('captureState');
  const next = { ...captureState, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ captureState: next });
  try {
    await chrome.runtime.sendMessage({ type: 'GFP_STATE_BROADCAST', state: next });
  } catch {
    // Popup pode estar fechado; ignorar silenciosamente
  }
  return next;
}

async function updateBadge(text = '', color = '#10b981') {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color });
    }
  } catch {
    // Ignorar caso a API não esteja pronta
  }
}

async function captureVisibleTabWithRetry(windowId, maxRetries = 25) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') && attempt < maxRetries - 1) {
        await sleep(75 + attempt * 15);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Limite de taxa do captureVisibleTab excedido.');
}

async function dataUrlToImageBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  return { bitmap, blob, width: bitmap.width, height: bitmap.height };
}

class OffscreenStitcher {
  constructor({ mimeType = 'image/png', quality = 0.94, maxSliceHeight = 30000 } = {}) {
    this.mimeType = mimeType;
    this.quality = quality;
    this.maxSliceHeight = maxSliceHeight;
    this.scaleMultiplier = 1;
    this.totalWidth = 0;
    this.totalHeight = 0;
    this.slices = [];
    this.metadata = { links: [] };
  }

  isEmpty() {
    return this.slices.length === 0;
  }

  setScaleMultiplier(scale) {
    if (scale && Number.isFinite(scale) && scale > 0) {
      this.scaleMultiplier = scale;
    }
  }

  initCanvases(logicalWidth, logicalHeight, bg = '#ffffff') {
    const physW = Math.max(1, Math.round(logicalWidth * this.scaleMultiplier));
    const physH = Math.max(1, Math.round(logicalHeight * this.scaleMultiplier));
    this.totalWidth = physW;
    this.totalHeight = physH;

    const maxH = Math.max(4096, this.maxSliceHeight || 30000);
    const count = Math.max(1, Math.ceil(physH / maxH));
    this.slices = [];

    for (let i = 0; i < count; i++) {
      const top = i * maxH;
      const height = i === count - 1 ? physH - top : maxH;
      const canvas = new OffscreenCanvas(physW, Math.max(1, height));
      const ctx = canvas.getContext('2d');
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      this.slices.push({
        index: i,
        canvas,
        ctx,
        left: 0,
        top,
        right: physW,
        bottom: top + height,
        width: physW,
        height
      });
    }
  }

  ensureHeight(newLogicalHeight, bg = '#ffffff') {
    const newPhysH = Math.max(1, Math.round(newLogicalHeight * this.scaleMultiplier));
    if (newPhysH <= this.totalHeight) return;

    const maxH = Math.max(4096, this.maxSliceHeight || 30000);
    const last = this.slices[this.slices.length - 1];
    if (last && last.height < maxH) {
      const growTo = Math.min(maxH, newPhysH - last.top);
      if (growTo > last.height) {
        const temp = new OffscreenCanvas(last.width, last.height);
        temp.getContext('2d').drawImage(last.canvas, 0, 0);
        last.canvas.height = growTo;
        if (bg) {
          last.ctx.fillStyle = bg;
          last.ctx.fillRect(0, 0, last.width, growTo);
        }
        last.ctx.drawImage(temp, 0, 0);
        last.height = growTo;
        last.bottom = last.top + growTo;
      }
    }

    let covered = this.slices.length ? this.slices[this.slices.length - 1].bottom : 0;
    while (covered < newPhysH) {
      const h = Math.min(maxH, newPhysH - covered);
      const canvas = new OffscreenCanvas(this.totalWidth, h);
      const ctx = canvas.getContext('2d');
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      this.slices.push({
        index: this.slices.length,
        canvas,
        ctx,
        left: 0,
        top: covered,
        right: this.totalWidth,
        bottom: covered + h,
        width: this.totalWidth,
        height: h
      });
      covered += h;
    }

    this.totalHeight = newPhysH;
  }

  drawStep({ bitmap, destX, destY, clipX = 0, clipY = 0, clipWidth, clipHeight }) {
    const s = this.scaleMultiplier;
    const dx = Math.round(destX * s);
    const dy = Math.round(destY * s);
    const sx = Math.round(clipX * s);
    const sy = Math.round(clipY * s);
    const sw = Math.round((clipWidth ?? bitmap.width / s) * s);
    const sh = Math.round((clipHeight ?? bitmap.height / s) * s);
    if (sw <= 0 || sh <= 0) return;

    const targetTop = dy;
    const targetBottom = dy + sh;

    for (const slice of this.slices) {
      if (targetBottom <= slice.top || targetTop >= slice.bottom) continue;
      const localY = dy - slice.top;
      slice.ctx.save();
      slice.ctx.beginPath();
      slice.ctx.rect(dx, Math.max(0, localY), sw, sh);
      slice.ctx.clip();
      slice.ctx.drawImage(bitmap, sx, sy, sw, sh, dx, localY, sw, sh);
      slice.ctx.restore();
    }
  }

  cropHeightTo(logicalFinalHeight) {
    const physFinalH = Math.max(1, Math.round(logicalFinalHeight * this.scaleMultiplier));
    if (physFinalH >= this.totalHeight) return;

    const kept = [];
    for (const slice of this.slices) {
      if (slice.top >= physFinalH) break;
      if (slice.bottom > physFinalH) {
        const newH = physFinalH - slice.top;
        const temp = new OffscreenCanvas(slice.width, newH);
        temp.getContext('2d').drawImage(slice.canvas, 0, 0, slice.width, newH, 0, 0, slice.width, newH);
        slice.canvas.height = newH;
        slice.ctx.drawImage(temp, 0, 0);
        slice.height = newH;
        slice.bottom = slice.top + newH;
      }
      kept.push(slice);
    }
    this.slices = kept;
    this.totalHeight = physFinalH;
  }

  appendLinks(links = []) {
    if (!Array.isArray(links) || !links.length) return;
    const existing = this.metadata.links || [];
    const seen = new Set(existing.map((l) => `${l.url}|${Math.round(l.x)}|${Math.round(l.y)}`));
    for (const link of links) {
      if (!link?.url || link.width <= 0 || link.height <= 0) continue;
      const key = `${link.url}|${Math.round(link.x)}|${Math.round(link.y)}`;
      if (!seen.has(key)) {
        seen.add(key);
        existing.push(link);
      }
    }
    this.metadata.links = existing;
  }

  async toSliceBlobs() {
    const out = [];
    for (const slice of this.slices) {
      const blob = await slice.canvas.convertToBlob({
        type: this.mimeType,
        quality: this.quality
      });
      out.push({
        index: slice.index,
        blob,
        width: slice.width,
        height: slice.height,
        top: slice.top,
        left: slice.left
      });
    }
    return out;
  }
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'GFP_PING' });
    if (pong?.ok) return true;
  } catch {
    // Ainda não injetado
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/capturer.js']
  });
  return true;
}

async function finalizeAndOpenCapture(session) {
  await setSessionState({ status: 'saving', progress: 0.99, message: 'Salvando captura...' });
  await updateBadge('...', '#3b82f6');

  const settings = session.settings || (await loadSettings());
  const fmtSpec = IMAGE_FORMATS[settings.imageFormat] || IMAGE_FORMATS.png;
  const slices = await session.stitcher.toSliceBlobs();

  const record = await saveCaptureRecord({
    url: session.tab.url || '',
    title: session.tab.title || 'Captura de Página',
    captureMode: session.mode,
    format: settings.imageFormat || 'png',
    mimeType: fmtSpec.mime,
    scaleMultiplier: session.stitcher.scaleMultiplier,
    width: session.stitcher.totalWidth,
    height: session.stitcher.totalHeight,
    slices,
    metadata: session.stitcher.metadata,
    createdAt: Date.now()
  });

  activeSession = null;
  await setSessionState({ status: 'idle', progress: 1, lastCaptureId: record.id, message: '' });
  await updateBadge('');

  if (settings.autoDownload) {
    try {
      const subdir = sanitizeSubdirectory(settings.downloadSubdir);
      for (let i = 0; i < slices.length; i++) {
        const fname = formatFilename({
          template: settings.filenameTemplate,
          record,
          ext: fmtSpec.ext,
          sliceIndex: i,
          totalSlices: slices.length
        });
        const fullPath = subdir ? `${subdir}/${fname}` : fname;
        const dataUrl = await blobToDataUrlInWorker(slices[i].blob);
        await chrome.downloads.download({
          url: dataUrl,
          filename: fullPath,
          conflictAction: 'uniquify',
          saveAs: false
        });
      }
    } catch (err) {
      console.error('Erro no auto-download:', err);
    }
  }

  const viewerUrl = chrome.runtime.getURL(`src/viewer/viewer.html?id=${encodeURIComponent(record.id)}`);
  await chrome.tabs.create({
    url: viewerUrl,
    index: (session.tab.index ?? 0) + 1,
    openerTabId: session.tab.id,
    active: true
  });

  return record;
}

function blobToDataUrlInWorker(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function runVisibleCapture(tab, settings) {
  const fmtSpec = IMAGE_FORMATS[settings.imageFormat] || IMAGE_FORMATS.png;
  const stitcher = new OffscreenStitcher({
    mimeType: fmtSpec.mime,
    quality: settings.jpegQuality,
    maxSliceHeight: settings.maxCanvasHeight
  });

  await setSessionState({
    status: 'capturing',
    mode: 'visible',
    progress: 0.4,
    sliceCount: 1,
    message: 'Capturando área visível...'
  });
  await updateBadge('VIS', '#10b981');

  const dataUrl = await captureVisibleTabWithRetry(tab.windowId);
  const { bitmap, width, height } = await dataUrlToImageBitmap(dataUrl);
  const dpr = tab.width ? width / tab.width : 1;
  stitcher.setScaleMultiplier(dpr);
  stitcher.initCanvases(width / dpr, height / dpr, '#ffffff');
  stitcher.drawStep({
    bitmap,
    destX: 0,
    destY: 0,
    clipX: 0,
    clipY: 0,
    clipWidth: width / dpr,
    clipHeight: height / dpr
  });
  bitmap.close();

  try {
    await ensureContentScript(tab.id);
    const metrics = await chrome.tabs.sendMessage(tab.id, { type: 'GFP_COLLECT_PAGE_METRICS' });
    if (metrics?.links) {
      stitcher.appendLinks(metrics.links);
    }
  } catch {
    // Página restrita onde content script não roda; segue com a imagem visível
  }

  return finalizeAndOpenCapture({ tab, mode: 'visible', settings, stitcher });
}

async function runCdpInstantCapture(tab, settings) {
  const fmtSpec = IMAGE_FORMATS[settings.imageFormat] || IMAGE_FORMATS.png;
  const stitcher = new OffscreenStitcher({
    mimeType: fmtSpec.mime,
    quality: settings.jpegQuality,
    maxSliceHeight: settings.maxCanvasHeight
  });

  await setSessionState({
    status: 'capturing',
    mode: 'cdp',
    progress: 0.25,
    sliceCount: 1,
    message: 'Capturando página completa via protocolo CDP...'
  });
  await updateBadge('CDP', '#6366f1');

  let pageMetrics = null;
  try {
    await ensureContentScript(tab.id);
    pageMetrics = await chrome.tabs.sendMessage(tab.id, { type: 'GFP_COLLECT_PAGE_METRICS' });
  } catch {
    // Ignorar se não disponível
  }

  const debugTarget = { tabId: tab.id };
  let attached = false;
  try {
    await chrome.debugger.attach(debugTarget, '1.3');
    attached = true;
    await chrome.debugger.sendCommand(debugTarget, 'Page.enable');
    const layout = await chrome.debugger.sendCommand(debugTarget, 'Page.getLayoutMetrics');
    const contentSize = layout.cssContentSize || layout.contentSize || { width: tab.width || 1280, height: tab.height || 900 };

    const fullW = Math.max(320, Math.ceil(contentSize.width));
    const fullH = Math.max(240, Math.ceil(contentSize.height));
    const dpr = pageMetrics?.devicePixelRatio || 1;

    stitcher.setScaleMultiplier(dpr);
    stitcher.initCanvases(fullW, fullH, '#ffffff');
    if (pageMetrics?.links) {
      stitcher.appendLinks(pageMetrics.links);
    }

    // Divide em blocos de até 8192px lógicos para evitar estouro de textura da GPU no CDP
    const maxChunkH = 8192;
    const totalChunks = Math.ceil(fullH / maxChunkH);

    for (let i = 0; i < totalChunks; i++) {
      const y = i * maxChunkH;
      const h = Math.min(maxChunkH, fullH - y);
      await setSessionState({
        status: 'capturing',
        mode: 'cdp',
        progress: 0.3 + ((i + 0.5) / totalChunks) * 0.6,
        sliceCount: stitcher.slices.length,
        message: `Renderizando bloco CDP ${i + 1}/${totalChunks}...`
      });

      const shot = await chrome.debugger.sendCommand(debugTarget, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        fromSurface: true,
        clip: {
          x: 0,
          y,
          width: fullW,
          height: h,
          scale: 1
        }
      });

      if (!shot?.data) {
        throw new Error('CDP não retornou dados de imagem.');
      }

      const dataUrl = `data:image/png;base64,${shot.data}`;
      const { bitmap } = await dataUrlToImageBitmap(dataUrl);
      // Ajusta scaleMultiplier real na primeira fatia
      if (i === 0) {
        const realScale = bitmap.width / fullW;
        if (Math.abs(realScale - stitcher.scaleMultiplier) > 0.05) {
          stitcher.setScaleMultiplier(realScale);
          stitcher.initCanvases(fullW, fullH, '#ffffff');
        }
      }
      stitcher.drawStep({
        bitmap,
        destX: 0,
        destY: y,
        clipX: 0,
        clipY: 0,
        clipWidth: fullW,
        clipHeight: h
      });
      bitmap.close();
    }
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debugTarget);
      } catch {
        // Ignorar se já desconectado
      }
    }
  }

  return finalizeAndOpenCapture({ tab, mode: 'cdp', settings, stitcher });
}

async function startScrollOrPickerSession({ tab, mode = 'scroll', settings }) {
  const fmtSpec = IMAGE_FORMATS[settings.imageFormat] || IMAGE_FORMATS.png;
  const stitcher = new OffscreenStitcher({
    mimeType: fmtSpec.mime,
    quality: settings.jpegQuality,
    maxSliceHeight: settings.maxCanvasHeight
  });

  activeSession = {
    tab,
    mode,
    settings,
    stitcher,
    stopRequested: false
  };

  await ensureContentScript(tab.id);

  if (mode === 'picker') {
    await setSessionState({
      status: 'picking',
      mode: 'picker',
      progress: 0,
      message: 'Clique em qualquer elemento ou container rolável na página...'
    });
    await updateBadge('PICK', '#f59e0b');
    await chrome.tabs.sendMessage(tab.id, {
      type: 'GFP_START_PICKER',
      options: settings
    });
    return { status: 'picking' };
  }

  await setSessionState({
    status: 'capturing',
    mode: 'scroll',
    progress: 0.02,
    sliceCount: 1,
    message: 'Rolando e capturando página inteira...'
  });
  await updateBadge('0%', '#10b981');

  await chrome.tabs.sendMessage(tab.id, {
    type: 'GFP_START_SCROLL_CAPTURE',
    options: settings
  });

  return { status: 'capturing' };
}

export async function initiateCapture({ tab, mode }) {
  const { captureState } = await chrome.storage.session.get('captureState');
  if (captureState?.status === 'capturing' || captureState?.status === 'saving') {
    return { alreadyRunning: true, state: captureState };
  }

  const settings = await loadSettings();
  const chosenMode = mode || settings.defaultCaptureMode || 'scroll';

  try {
    if (chosenMode === 'visible') {
      await runVisibleCapture(tab, settings);
      return { ok: true };
    }
    if (chosenMode === 'cdp') {
      await runCdpInstantCapture(tab, settings);
      return { ok: true };
    }
    return await startScrollOrPickerSession({ tab, mode: chosenMode, settings });
  } catch (err) {
    // Fallback inteligente: se a página bloquear content script (ex.: páginas restritas), captura a área visível
    const msg = err?.message || String(err);
    if (
      chosenMode !== 'visible' &&
      (msg.includes('Cannot access') ||
        msg.includes('extensions gallery') ||
        msg.includes('chrome://') ||
        msg.includes('edge://'))
    ) {
      try {
        await runVisibleCapture(tab, settings);
        return { ok: true, fallbackVisible: true };
      } catch (innerErr) {
        await handleCaptureFailure(innerErr);
        throw innerErr;
      }
    }
    await handleCaptureFailure(err);
    throw err;
  }
}

async function handleCaptureFailure(err) {
  activeSession = null;
  const errMsg = err?.message || String(err);
  await setSessionState({
    status: 'error',
    progress: 0,
    error: errMsg,
    message: `Erro: ${errMsg}`
  });
  await updateBadge('ERR', '#ef4444');
  setTimeout(() => updateBadge(''), 4000);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.storage.session.set({ captureState: { status: 'idle', progress: 0 } });

  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'gfp-context-full',
      title: 'Capturar Página Inteira (GetFullPage)',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: 'gfp-context-picker',
      title: 'Selecionar Container / Elemento para Capturar...',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: 'gfp-context-visible',
      title: 'Capturar Apenas Área Visível',
      contexts: ['page', 'frame']
    });
  } catch (err) {
    console.warn('Aviso ao registrar menu de contexto:', err);
  }

  if (details.reason === 'install') {
    const existing = await chrome.storage.local.get('gfp_settings');
    if (!existing.gfp_settings) {
      await loadSettings();
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const modeMap = {
    'gfp-context-full': 'scroll',
    'gfp-context-picker': 'picker',
    'gfp-context-visible': 'visible'
  };
  const mode = modeMap[info.menuItemId];
  if (!mode) return;

  await updateBadge('...', '#10b981');
  try {
    await initiateCapture({ tab, mode });
  } catch (err) {
    console.error('Erro ao iniciar captura pelo menu de contexto:', err);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-visible-quick') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await initiateCapture({ tab, mode: 'visible' });
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  (async () => {
    try {
      if (msg.type === 'GFP_START_CAPTURE_CMD') {
        let tab = msg.tab;
        if (!tab) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tab = activeTab;
        }
        if (!tab) throw new Error('Nenhuma aba ativa encontrada.');
        const res = await initiateCapture({ tab, mode: msg.mode });
        sendResponse({ ok: true, ...res });
        return;
      }

      if (msg.type === 'GFP_STOP_CAPTURE_CMD') {
        if (activeSession?.tab?.id) {
          activeSession.stopRequested = true;
          try {
            await chrome.tabs.sendMessage(activeSession.tab.id, { type: 'GFP_STOP_CAPTURE' });
          } catch {
            // Ignorar erro de envio
          }
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'GFP_PICKER_SELECTED') {
        if (activeSession) {
          await setSessionState({
            status: 'capturing',
            mode: 'picker',
            progress: 0.05,
            sliceCount: 1,
            message: 'Capturando elemento selecionado...'
          });
          await updateBadge('0%', '#10b981');
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'GFP_CAPTURE_STEP') {
        if (!activeSession) {
          sendResponse({ stop: true });
          return;
        }

        const { stitcher, tab } = activeSession;
        const dataUrl = await captureVisibleTabWithRetry(tab.windowId);
        const { bitmap, width } = await dataUrlToImageBitmap(dataUrl);

        const scale = msg.windowWidth ? width / msg.windowWidth : msg.devicePixelRatio || 1;
        stitcher.setScaleMultiplier(scale);

        if (stitcher.isEmpty()) {
          stitcher.initCanvases(msg.totalWidth, msg.totalHeight, msg.canvasBg || '#ffffff');
          stitcher.metadata.windowWidth = msg.windowWidth;
          stitcher.metadata.windowHeight = msg.windowHeight;
          stitcher.metadata.dpr = msg.devicePixelRatio || scale;
        } else if (msg.totalHeight * scale > stitcher.totalHeight) {
          stitcher.ensureHeight(msg.totalHeight, msg.canvasBg || '#ffffff');
        }

        stitcher.drawStep({
          bitmap,
          destX: msg.destX,
          destY: msg.destY,
          clipX: msg.clipX,
          clipY: msg.clipY,
          clipWidth: msg.clipWidth,
          clipHeight: msg.clipHeight
        });
        bitmap.close();

        if (msg.links?.length) {
          stitcher.appendLinks(msg.links);
        }

        const pct = Math.min(99, Math.max(1, Math.round((msg.progress || 0) * 100)));
        await updateBadge(`${pct}%`, '#10b981');
        await setSessionState({
          status: 'capturing',
          mode: activeSession.mode,
          progress: msg.progress || 0,
          sliceCount: stitcher.slices.length,
          message: `Capturando página (${pct}%)...`
        });

        sendResponse({ ok: true, stop: Boolean(activeSession.stopRequested) });
        return;
      }

      if (msg.type === 'GFP_CAPTURE_DONE') {
        if (!activeSession) {
          sendResponse({ ok: false });
          return;
        }
        if (msg.finalHeight && msg.finalHeight > 0) {
          activeSession.stitcher.cropHeightTo(msg.finalHeight);
        }
        const record = await finalizeAndOpenCapture(activeSession);
        sendResponse({ ok: true, recordId: record.id });
        return;
      }

      if (msg.type === 'GFP_CAPTURE_ERROR') {
        await handleCaptureFailure(new Error(msg.error || 'Falha durante a captura na página.'));
        sendResponse({ ok: false });
        return;
      }

      sendResponse({ ok: false, error: 'Mensagem desconhecida' });
    } catch (err) {
      await handleCaptureFailure(err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
