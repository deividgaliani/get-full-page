import { renderMetadataHeaderCanvas, canvasToBlob } from '../lib/stitcher.js';
import { formatCaptureDate } from '../lib/settings.js';

export class ProScreenshotEditor {
  constructor({
    containerEl,
    sourceImages,
    record,
    initialState = null,
    onStateChange = () => {}
  }) {
    this.containerEl = containerEl;
    this.sourceImages = sourceImages; // Array de { img, width, height }
    this.record = record;
    this.onStateChange = onStateChange;

    // Monta um canvas base único com a imagem original (ou fatias unificadas para edição)
    this.baseCanvas = document.createElement('canvas');
    const totalW = sourceImages[0]?.width || 1200;
    const totalH = sourceImages.reduce((acc, s) => acc + s.height, 0) || 800;
    // Limita altura do canvas de edição a 32.000px para segurança de memória da GPU
    const safeH = Math.min(32000, totalH);
    this.baseCanvas.width = totalW;
    this.baseCanvas.height = safeH;
    const baseCtx = this.baseCanvas.getContext('2d');
    let yOffset = 0;
    for (const s of sourceImages) {
      if (yOffset >= safeH) break;
      const drawH = Math.min(s.height, safeH - yOffset);
      baseCtx.drawImage(s.img || s.canvas, 0, 0, s.width, drawH, 0, yOffset, totalW, drawH);
      yOffset += drawH;
    }

    this.state = initialState
      ? structuredClone(initialState)
      : {
          crop: null, // { x, y, w, h } em coordenadas do baseCanvas
          padding: 0,
          paddingColor: '#1e293b',
          borderRadius: 0,
          browserFrame: 'none', // 'none' | 'dark' | 'light' | 'macos' | 'windows'
          layers: [], // Array de objetos de anotação
          stepCounter: 1
        };

    this.undoStack = [];
    this.redoStack = [];

    this.activeTool = 'select'; // 'select' | 'crop' | 'blur' | 'arrow' | 'rect' | 'ellipse' | 'line' | 'text' | 'step'
    this.strokeColor = '#ef4444';
    this.strokeWidth = 4;
    this.fillShape = false;

    this.selectedLayerId = null;
    this.interaction = null; // Estado de drag/draw em andamento

    this.displayCanvas = document.createElement('canvas');
    this.displayCanvas.className = 'editor-canvas';
    this.ctx = this.displayCanvas.getContext('2d');

    this.containerEl.innerHTML = '';
    this.containerEl.appendChild(this.displayCanvas);

    this._bindEvents();
    this.render();
  }

  pushHistory() {
    this.undoStack.push(structuredClone(this.state));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    this.onStateChange(this.getHistoryInfo());
  }

  getHistoryInfo() {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      hasCrop: Boolean(this.state.crop),
      selectedLayerId: this.selectedLayerId,
      layerCount: this.state.layers.length,
      state: this.state
    };
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(structuredClone(this.state));
    this.state = this.undoStack.pop();
    this.selectedLayerId = null;
    this.render();
    this.onStateChange(this.getHistoryInfo());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(structuredClone(this.state));
    this.state = this.redoStack.pop();
    this.selectedLayerId = null;
    this.render();
    this.onStateChange(this.getHistoryInfo());
  }

  clearAllEdits() {
    this.pushHistory();
    this.state = {
      crop: null,
      padding: 0,
      paddingColor: '#1e293b',
      borderRadius: 0,
      browserFrame: 'none',
      layers: [],
      stepCounter: 1
    };
    this.selectedLayerId = null;
    this.render();
    this.onStateChange(this.getHistoryInfo());
  }

  setTool(tool) {
    this.activeTool = tool;
    if (tool !== 'select') {
      this.selectedLayerId = null;
    }
    this.displayCanvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    this.render();
  }

  setStyleOptions({ color, strokeWidth, fillShape }) {
    if (color !== undefined) this.strokeColor = color;
    if (strokeWidth !== undefined) this.strokeWidth = Number(strokeWidth) || 4;
    if (fillShape !== undefined) this.fillShape = Boolean(fillShape);

    if (this.selectedLayerId) {
      const layer = this.state.layers.find((l) => l.id === this.selectedLayerId);
      if (layer) {
        this.pushHistory();
        if (color !== undefined) layer.color = this.strokeColor;
        if (strokeWidth !== undefined) layer.strokeWidth = this.strokeWidth;
        if (fillShape !== undefined) layer.fill = this.fillShape;
        this.render();
      }
    }
  }

  setFormatting({ padding, paddingColor, borderRadius, browserFrame }) {
    this.pushHistory();
    if (padding !== undefined) this.state.padding = Math.max(0, Number(padding) || 0);
    if (paddingColor !== undefined) this.state.paddingColor = paddingColor;
    if (borderRadius !== undefined) this.state.borderRadius = Math.max(0, Number(borderRadius) || 0);
    if (browserFrame !== undefined) this.state.browserFrame = browserFrame;
    this.render();
    this.onStateChange(this.getHistoryInfo());
  }

  resetCrop() {
    if (!this.state.crop) return;
    this.pushHistory();
    this.state.crop = null;
    this.render();
    this.onStateChange(this.getHistoryInfo());
  }

  deleteSelectedLayer() {
    if (!this.selectedLayerId) return;
    this.pushHistory();
    this.state.layers = this.state.layers.filter((l) => l.id !== this.selectedLayerId);
    this.selectedLayerId = null;
    this.render();
    this.onStateChange(this.getHistoryInfo());
  }

  _getCropRect() {
    if (this.state.crop && this.state.crop.w > 20 && this.state.crop.h > 20) {
      return this.state.crop;
    }
    return { x: 0, y: 0, w: this.baseCanvas.width, h: this.baseCanvas.height };
  }

  _getLayoutMetrics() {
    const crop = this._getCropRect();
    const scale = this.record?.scaleMultiplier || 1;
    const pad = Math.round((this.state.padding || 0) * scale);

    let headerInfo = null;
    let headerH = 0;
    if (this.state.browserFrame && this.state.browserFrame !== 'none') {
      const dateText = formatCaptureDate(this.record?.createdAt || Date.now(), 'br');
      headerInfo = renderMetadataHeaderCanvas({
        width: crop.w,
        scaleMultiplier: scale,
        url: this.record?.url || '',
        title: this.record?.title || '',
        dateText,
        theme: this.state.browserFrame
      });
      headerH = headerInfo.physicalHeight;
    }

    const innerW = crop.w;
    const innerH = crop.h + headerH;
    const totalW = innerW + pad * 2;
    const totalH = innerH + pad * 2;

    return {
      crop,
      scale,
      pad,
      headerInfo,
      headerH,
      innerW,
      innerH,
      totalW,
      totalH,
      imageOriginX: pad,
      imageOriginY: pad + headerH
    };
  }

  _clientToImageCoords(clientX, clientY) {
    const rect = this.displayCanvas.getBoundingClientRect();
    const scaleX = this.displayCanvas.width / Math.max(1, rect.width);
    const scaleY = this.displayCanvas.height / Math.max(1, rect.height);
    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;

    const metrics = this._getLayoutMetrics();
    // Coordenadas relativas ao baseCanvas original
    const baseX = canvasX - metrics.imageOriginX + metrics.crop.x;
    const baseY = canvasY - metrics.imageOriginY + metrics.crop.y;
    return { baseX, baseY, canvasX, canvasY };
  }

  _hitTestLayer(baseX, baseY) {
    for (let i = this.state.layers.length - 1; i >= 0; i--) {
      const l = this.state.layers[i];
      const minX = Math.min(l.x1, l.x2 ?? l.x1) - 12;
      const maxX = Math.max(l.x1, l.x2 ?? l.x1 + (l.w || 60)) + 12;
      const minY = Math.min(l.y1, l.y2 ?? l.y1) - 12;
      const maxY = Math.max(l.y1, l.y2 ?? l.y1 + (l.h || 40)) + 12;
      if (baseX >= minX && baseX <= maxX && baseY >= minY && baseY <= maxY) {
        return l;
      }
    }
    return null;
  }

  _bindEvents() {
    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const { baseX, baseY } = this._clientToImageCoords(e.clientX, e.clientY);
      const scale = this.record?.scaleMultiplier || 1;

      if (this.activeTool === 'select') {
        const hit = this._hitTestLayer(baseX, baseY);
        this.selectedLayerId = hit ? hit.id : null;
        if (hit) {
          this.pushHistory();
          this.interaction = {
            mode: 'move',
            layer: hit,
            startX: baseX,
            startY: baseY,
            origX1: hit.x1,
            origY1: hit.y1,
            origX2: hit.x2,
            origY2: hit.y2
          };
        }
        this.render();
        this.onStateChange(this.getHistoryInfo());
        return;
      }

      if (this.activeTool === 'step') {
        this.pushHistory();
        const num = this.state.stepCounter || 1;
        this.state.stepCounter = num + 1;
        const radius = Math.round(18 * scale);
        const layer = {
          id: `lyr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'step',
          x1: baseX - radius,
          y1: baseY - radius,
          x2: baseX + radius,
          y2: baseY + radius,
          number: num,
          color: this.strokeColor,
          strokeWidth: this.strokeWidth * scale
        };
        this.state.layers.push(layer);
        this.selectedLayerId = layer.id;
        this.render();
        this.onStateChange(this.getHistoryInfo());
        return;
      }

      if (this.activeTool === 'text') {
        const text = prompt('Digite o texto da anotação:', '');
        if (!text || !text.trim()) return;
        this.pushHistory();
        const fontSize = Math.round((14 + this.strokeWidth * 2.5) * scale);
        const layer = {
          id: `lyr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'text',
          x1: baseX,
          y1: baseY,
          x2: baseX + Math.max(120, text.length * fontSize * 0.62),
          y2: baseY + fontSize * 1.6,
          text: text.trim(),
          fontSize,
          color: this.strokeColor,
          fill: this.fillShape
        };
        this.state.layers.push(layer);
        this.selectedLayerId = layer.id;
        this.render();
        this.onStateChange(this.getHistoryInfo());
        return;
      }

      if (this.activeTool === 'crop') {
        this.interaction = {
          mode: 'crop',
          startX: Math.max(0, Math.min(this.baseCanvas.width, baseX)),
          startY: Math.max(0, Math.min(this.baseCanvas.height, baseY)),
          curX: baseX,
          curY: baseY
        };
        return;
      }

      // Ferramentas de desenho por arraste: blur, arrow, rect, ellipse, line
      this.pushHistory();
      const newLayer = {
        id: `lyr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: this.activeTool,
        x1: baseX,
        y1: baseY,
        x2: baseX,
        y2: baseY,
        color: this.strokeColor,
        strokeWidth: Math.max(2, this.strokeWidth * scale),
        fill: this.fillShape
      };
      this.state.layers.push(newLayer);
      this.selectedLayerId = newLayer.id;
      this.interaction = {
        mode: 'draw',
        layer: newLayer
      };
    };

    const onPointerMove = (e) => {
      if (!this.interaction) return;
      const { baseX, baseY } = this._clientToImageCoords(e.clientX, e.clientY);

      if (this.interaction.mode === 'move') {
        const dx = baseX - this.interaction.startX;
        const dy = baseY - this.interaction.startY;
        const l = this.interaction.layer;
        l.x1 = this.interaction.origX1 + dx;
        l.y1 = this.interaction.origY1 + dy;
        if (typeof this.interaction.origX2 === 'number') l.x2 = this.interaction.origX2 + dx;
        if (typeof this.interaction.origY2 === 'number') l.y2 = this.interaction.origY2 + dy;
        this.render();
        return;
      }

      if (this.interaction.mode === 'crop') {
        this.interaction.curX = Math.max(0, Math.min(this.baseCanvas.width, baseX));
        this.interaction.curY = Math.max(0, Math.min(this.baseCanvas.height, baseY));
        this.render();
        return;
      }

      if (this.interaction.mode === 'draw') {
        this.interaction.layer.x2 = baseX;
        this.interaction.layer.y2 = baseY;
        this.render();
      }
    };

    const onPointerUp = () => {
      if (!this.interaction) return;
      if (this.interaction.mode === 'crop') {
        const x1 = Math.min(this.interaction.startX, this.interaction.curX);
        const y1 = Math.min(this.interaction.startY, this.interaction.curY);
        const w = Math.abs(this.interaction.curX - this.interaction.startX);
        const h = Math.abs(this.interaction.curY - this.interaction.startY);
        this.interaction = null;
        if (w > 24 && h > 24) {
          this.pushHistory();
          this.state.crop = {
            x: Math.round(x1),
            y: Math.round(y1),
            w: Math.round(w),
            h: Math.round(h)
          };
          this.activeTool = 'select';
        }
        this.render();
        this.onStateChange(this.getHistoryInfo());
        return;
      }

      this.interaction = null;
      this.render();
      this.onStateChange(this.getHistoryInfo());
    };

    this.displayCanvas.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
  }

  _drawPixelatedBlur(ctx, x, y, w, h, destX, destY) {
    if (w < 4 || h < 4) return;
    const blockSize = Math.max(8, Math.round(Math.min(w, h) / 10));
    const smallW = Math.max(1, Math.ceil(w / blockSize));
    const smallH = Math.max(1, Math.ceil(h / blockSize));

    const temp = document.createElement('canvas');
    temp.width = smallW;
    temp.height = smallH;
    const tctx = temp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(this.baseCanvas, x, y, w, h, 0, 0, smallW, smallH);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(temp, 0, 0, smallW, smallH, destX, destY, w, h);
    ctx.restore();
  }

  _drawArrow(ctx, x1, y1, x2, y2, color, lineWidth) {
    const headLen = Math.max(14, lineWidth * 3.6);
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  render(includeSelectionHandles = true) {
    const metrics = this._getLayoutMetrics();
    const { crop, scale, pad, headerInfo, headerH, innerW, innerH, totalW, totalH, imageOriginX, imageOriginY } =
      metrics;

    if (this.displayCanvas.width !== totalW || this.displayCanvas.height !== totalH) {
      this.displayCanvas.width = totalW;
      this.displayCanvas.height = totalH;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, totalW, totalH);

    // 1. Fundo de Padding externo (se padding > 0)
    if (pad > 0) {
      ctx.fillStyle = this.state.paddingColor || '#1e293b';
      ctx.fillRect(0, 0, totalW, totalH);
    }

    // 2. Recorte com cantos arredondados para a janela interna (header + imagem)
    const radius = Math.round((this.state.borderRadius || 0) * scale);
    ctx.save();
    if (radius > 0 || pad > 0) {
      if (pad > 0) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = Math.round(24 * scale);
        ctx.shadowOffsetY = Math.round(8 * scale);
      }
      ctx.beginPath();
      ctx.roundRect(pad, pad, innerW, innerH, radius);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.clip();
    }

    // 3. Cabeçalho de navegador / barra de URL + data
    if (headerInfo) {
      ctx.drawImage(headerInfo.canvas, pad, pad);
    }

    // 4. Imagem base recortada
    ctx.drawImage(
      this.baseCanvas,
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      imageOriginX,
      imageOriginY,
      crop.w,
      crop.h
    );

    // 5. Camadas de anotação
    for (const layer of this.state.layers) {
      const lx1 = layer.x1 - crop.x + imageOriginX;
      const ly1 = layer.y1 - crop.y + imageOriginY;
      const lx2 = (layer.x2 ?? layer.x1) - crop.x + imageOriginX;
      const ly2 = (layer.y2 ?? layer.y1) - crop.y + imageOriginY;
      const rx = Math.min(lx1, lx2);
      const ry = Math.min(ly1, ly2);
      const rw = Math.abs(lx2 - lx1);
      const rh = Math.abs(ly2 - ly1);

      ctx.save();
      switch (layer.type) {
        case 'blur': {
          const srcX = Math.min(layer.x1, layer.x2);
          const srcY = Math.min(layer.y1, layer.y2);
          this._drawPixelatedBlur(ctx, srcX, srcY, rw, rh, rx, ry);
          break;
        }
        case 'rect': {
          ctx.strokeStyle = layer.color;
          ctx.fillStyle = layer.color;
          ctx.lineWidth = layer.strokeWidth || 4;
          if (layer.fill) {
            ctx.globalAlpha = 0.28;
            ctx.fillRect(rx, ry, rw, rh);
            ctx.globalAlpha = 1;
          }
          ctx.strokeRect(rx, ry, rw, rh);
          break;
        }
        case 'ellipse': {
          ctx.strokeStyle = layer.color;
          ctx.fillStyle = layer.color;
          ctx.lineWidth = layer.strokeWidth || 4;
          ctx.beginPath();
          ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
          if (layer.fill) {
            ctx.globalAlpha = 0.28;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          ctx.stroke();
          break;
        }
        case 'line': {
          ctx.strokeStyle = layer.color;
          ctx.lineWidth = layer.strokeWidth || 4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(lx1, ly1);
          ctx.lineTo(lx2, ly2);
          ctx.stroke();
          break;
        }
        case 'arrow': {
          this._drawArrow(ctx, lx1, ly1, lx2, ly2, layer.color, layer.strokeWidth || 4);
          break;
        }
        case 'step': {
          const cx = (lx1 + lx2) / 2;
          const cy = (ly1 + ly2) / 2;
          const rad = Math.max(14, Math.hypot(lx2 - lx1, ly2 - ly1) / 2);
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.fillStyle = layer.color;
          ctx.fill();
          ctx.lineWidth = Math.max(2, 2.5 * scale);
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          ctx.font = `700 ${Math.round(rad * 1.1)}px system-ui, -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(layer.number || 1), cx, cy + 1);
          break;
        }
        case 'text': {
          const fSize = layer.fontSize || Math.round(20 * scale);
          ctx.font = `700 ${fSize}px system-ui, -apple-system, sans-serif`;
          const metricsText = ctx.measureText(layer.text || '');
          const padX = Math.round(10 * scale);
          const padY = Math.round(6 * scale);
          const boxW = metricsText.width + padX * 2;
          const boxH = fSize + padY * 2;

          if (layer.fill !== false) {
            ctx.fillStyle = layer.color;
            ctx.beginPath();
            ctx.roundRect(lx1, ly1, boxW, boxH, Math.round(6 * scale));
            ctx.fill();
            ctx.fillStyle = '#ffffff';
          } else {
            ctx.fillStyle = layer.color;
          }
          ctx.textBaseline = 'middle';
          ctx.fillText(layer.text || '', lx1 + padX, ly1 + boxH / 2);
          break;
        }
      }

      if (includeSelectionHandles && layer.id === this.selectedLayerId) {
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(rx - 6, ry - 6, Math.max(24, rw) + 12, Math.max(24, rh) + 12);
      }
      ctx.restore();
    }

    // 6. Preview de recorte interativo em andamento
    if (this.interaction?.mode === 'crop') {
      const cx1 = Math.min(this.interaction.startX, this.interaction.curX) - crop.x + imageOriginX;
      const cy1 = Math.min(this.interaction.startY, this.interaction.curY) - crop.y + imageOriginY;
      const cw = Math.abs(this.interaction.curX - this.interaction.startX);
      const ch = Math.abs(this.interaction.curY - this.interaction.startY);

      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.fillRect(imageOriginX, imageOriginY, crop.w, crop.h);
      ctx.clearRect(cx1, cy1, cw, ch);
      ctx.drawImage(
        this.baseCanvas,
        Math.min(this.interaction.startX, this.interaction.curX),
        Math.min(this.interaction.startY, this.interaction.curY),
        cw,
        ch,
        cx1,
        cy1,
        cw,
        ch
      );
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(cx1, cy1, cw, ch);
      ctx.restore();
    }

    ctx.restore();
  }

  async exportToBlob(mimeType = 'image/png', quality = 0.94) {
    this.render(false);
    const blob = await canvasToBlob(this.displayCanvas, mimeType, quality);
    this.render(true);
    return {
      blob,
      width: this.displayCanvas.width,
      height: this.displayCanvas.height
    };
  }

  getExportCanvas() {
    this.render(false);
    const copy = document.createElement('canvas');
    copy.width = this.displayCanvas.width;
    copy.height = this.displayCanvas.height;
    copy.getContext('2d').drawImage(this.displayCanvas, 0, 0);
    this.render(true);
    return copy;
  }
}
