export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, src });
    img.onerror = (err) => reject(new Error(`Falha ao carregar imagem: ${err?.message || 'erro desconhecido'}`));
    img.src = src;
  });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function canvasToBlob(canvas, mimeType = 'image/png', quality = 0.94) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Falha ao converter canvas para Blob.'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

export class MultiCanvasStitcher {
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

  initCanvases(logicalWidth, logicalHeight, backgroundColor = '#ffffff') {
    const physWidth = Math.max(1, Math.round(logicalWidth * this.scaleMultiplier));
    const physHeight = Math.max(1, Math.round(logicalHeight * this.scaleMultiplier));
    this.totalWidth = physWidth;
    this.totalHeight = physHeight;

    const maxH = Math.max(4096, this.maxSliceHeight || 30000);
    const numSlices = Math.max(1, Math.ceil(physHeight / maxH));
    this.slices = [];

    for (let i = 0; i < numSlices; i++) {
      const top = i * maxH;
      const height = i === numSlices - 1 ? (physHeight - top) : maxH;
      const canvas = document.createElement('canvas');
      canvas.width = physWidth;
      canvas.height = Math.max(1, height);
      const ctx = canvas.getContext('2d');
      if (backgroundColor) {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      this.slices.push({
        index: i,
        canvas,
        ctx,
        left: 0,
        top,
        right: physWidth,
        bottom: top + height,
        width: physWidth,
        height
      });
    }
  }

  ensureHeight(newLogicalHeight, backgroundColor = '#ffffff') {
    const newPhysHeight = Math.max(1, Math.round(newLogicalHeight * this.scaleMultiplier));
    if (newPhysHeight <= this.totalHeight) return;

    const maxH = Math.max(4096, this.maxSliceHeight || 30000);
    const lastSlice = this.slices[this.slices.length - 1];
    if (lastSlice && lastSlice.height < maxH) {
      const growTo = Math.min(maxH, newPhysHeight - lastSlice.top);
      if (growTo > lastSlice.height) {
        const temp = document.createElement('canvas');
        temp.width = lastSlice.width;
        temp.height = lastSlice.height;
        temp.getContext('2d').drawImage(lastSlice.canvas, 0, 0);

        lastSlice.canvas.height = growTo;
        if (backgroundColor) {
          lastSlice.ctx.fillStyle = backgroundColor;
          lastSlice.ctx.fillRect(0, 0, lastSlice.width, growTo);
        }
        lastSlice.ctx.drawImage(temp, 0, 0);
        lastSlice.height = growTo;
        lastSlice.bottom = lastSlice.top + growTo;
      }
    }

    let coveredHeight = this.slices.length ? this.slices[this.slices.length - 1].bottom : 0;
    while (coveredHeight < newPhysHeight) {
      const height = Math.min(maxH, newPhysHeight - coveredHeight);
      const canvas = document.createElement('canvas');
      canvas.width = this.totalWidth;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (backgroundColor) {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      this.slices.push({
        index: this.slices.length,
        canvas,
        ctx,
        left: 0,
        top: coveredHeight,
        right: this.totalWidth,
        bottom: coveredHeight + height,
        width: this.totalWidth,
        height
      });
      coveredHeight += height;
    }

    this.totalHeight = newPhysHeight;
  }

  drawStep({ img, destX, destY, clipX = 0, clipY = 0, clipWidth, clipHeight }) {
    const s = this.scaleMultiplier;
    const dx = Math.round(destX * s);
    const dy = Math.round(destY * s);
    const sx = Math.round(clipX * s);
    const sy = Math.round(clipY * s);
    const sw = Math.round((clipWidth ?? (img.width / s)) * s);
    const sh = Math.round((clipHeight ?? (img.height / s)) * s);

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
      slice.ctx.drawImage(img, sx, sy, sw, sh, dx, localY, sw, sh);
      slice.ctx.restore();
    }
  }

  cropHeightTo(logicalFinalHeight) {
    const physFinalHeight = Math.max(1, Math.round(logicalFinalHeight * this.scaleMultiplier));
    if (physFinalHeight >= this.totalHeight) return;

    const kept = [];
    for (const slice of this.slices) {
      if (slice.top >= physFinalHeight) break;
      if (slice.bottom > physFinalHeight) {
        const newH = physFinalHeight - slice.top;
        const temp = document.createElement('canvas');
        temp.width = slice.width;
        temp.height = newH;
        temp.getContext('2d').drawImage(slice.canvas, 0, 0, slice.width, newH, 0, 0, slice.width, newH);
        slice.canvas.height = newH;
        slice.ctx.drawImage(temp, 0, 0);
        slice.height = newH;
        slice.bottom = slice.top + newH;
      }
      kept.push(slice);
    }
    this.slices = kept;
    this.totalHeight = physFinalHeight;
  }

  updateMetadata(meta) {
    this.metadata = {
      ...this.metadata,
      ...meta,
      links: this.metadata.links || []
    };
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

  async toSliceBlobs(mimeType = this.mimeType, quality = this.quality) {
    const out = [];
    for (const slice of this.slices) {
      const blob = await canvasToBlob(slice.canvas, mimeType, quality);
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

export function renderMetadataHeaderCanvas({
  width,
  scaleMultiplier = 1,
  url = '',
  title = '',
  dateText = '',
  theme = 'dark' // 'dark' | 'light' | 'macos' | 'windows'
}) {
  const s = scaleMultiplier || 1;
  const logicalWidth = Math.max(320, Math.round(width / s));
  const logicalHeight = theme === 'macos' || theme === 'windows' ? 44 : 38;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(logicalHeight * s);
  const ctx = canvas.getContext('2d');
  ctx.scale(s, s);

  const isLight = theme === 'light' || theme === 'macos';
  ctx.fillStyle = isLight ? '#f1f5f9' : '#0f172a';
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);

  ctx.strokeStyle = isLight ? '#cbd5e1' : '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, logicalHeight - 0.5);
  ctx.lineTo(logicalWidth, logicalHeight - 0.5);
  ctx.stroke();

  let leftX = 16;
  const centerY = logicalHeight / 2;

  if (theme === 'macos') {
    const dots = ['#ef4444', '#f59e0b', '#10b981'];
    dots.forEach((color, idx) => {
      ctx.beginPath();
      ctx.arc(18 + idx * 18, centerY, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
    leftX = 76;
  } else if (theme === 'windows') {
    // Windows control icons on the right
    ctx.strokeStyle = isLight ? '#475569' : '#94a3b8';
    ctx.lineWidth = 1.4;
    const rx = logicalWidth - 90;
    ctx.beginPath();
    ctx.moveTo(rx, centerY);
    ctx.lineTo(rx + 10, centerY);
    ctx.strokeRect(rx + 28, centerY - 5, 10, 10);
    ctx.moveTo(rx + 56, centerY - 5);
    ctx.lineTo(rx + 66, centerY + 5);
    ctx.moveTo(rx + 66, centerY - 5);
    ctx.lineTo(rx + 56, centerY + 5);
    ctx.stroke();
  }

  // URL pill bar
  const pillRightMargin = dateText ? Math.min(240, dateText.length * 7.5 + 32) : 20;
  const pillWidth = Math.max(120, logicalWidth - leftX - pillRightMargin - (theme === 'windows' ? 95 : 0));
  const pillHeight = 26;
  const pillY = centerY - pillHeight / 2;

  ctx.fillStyle = isLight ? '#ffffff' : '#1e293b';
  ctx.beginPath();
  ctx.roundRect(leftX, pillY, pillWidth, pillHeight, 6);
  ctx.fill();

  // Lock icon + URL text
  ctx.fillStyle = isLight ? '#0f172a' : '#f8fafc';
  ctx.font = '500 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';

  const displayUrl = url || title || 'Captura de Página';
  const maxChars = Math.max(20, Math.floor((pillWidth - 24) / 6.8));
  const truncatedUrl = displayUrl.length > maxChars ? `${displayUrl.slice(0, maxChars - 1)}…` : displayUrl;
  ctx.fillText(`🔒 ${truncatedUrl}`, leftX + 10, centerY);

  if (dateText) {
    ctx.fillStyle = isLight ? '#475569' : '#94a3b8';
    ctx.font = '500 11.5px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    const rightPos = logicalWidth - (theme === 'windows' ? 108 : 16);
    ctx.fillText(dateText, rightPos, centerY);
    ctx.textAlign = 'left';
  }

  return {
    canvas,
    physicalHeight: canvas.height,
    logicalHeight,
    urlLinkRect: url
      ? {
          x: leftX,
          y: pillY,
          width: pillWidth,
          height: pillHeight,
          url
        }
      : null
  };
}

export const GOOGLE_DOCS_MAX_PIXELS = 25000000;

export async function copyCanvasOrImageToClipboard(sourceImages, fitGoogleDocs = false) {
  const list = Array.isArray(sourceImages) ? sourceImages : [sourceImages];
  if (!list.length) throw new Error('Nenhuma imagem para copiar.');

  const totalWidth = list[0].width;
  const totalHeight = list.reduce((acc, item) => acc + item.height, 0);

  let scale = 1;
  const totalPixels = totalWidth * totalHeight;
  if (fitGoogleDocs && totalPixels > GOOGLE_DOCS_MAX_PIXELS) {
    scale = Math.sqrt(GOOGLE_DOCS_MAX_PIXELS / totalPixels) * 0.98;
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = Math.max(1, Math.floor(totalWidth * scale));
  outCanvas.height = Math.max(1, Math.floor(totalHeight * scale));
  const ctx = outCanvas.getContext('2d');

  let curY = 0;
  for (const item of list) {
    const drawEl = item.canvas || item.img || item;
    const h = Math.floor(item.height * scale);
    ctx.drawImage(drawEl, 0, 0, item.width, item.height, 0, curY, outCanvas.width, h);
    curY += h;
  }

  const blob = await canvasToBlob(outCanvas, 'image/png');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return { resized: scale < 1, width: outCanvas.width, height: outCanvas.height };
}
