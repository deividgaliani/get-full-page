import { PAPER_SIZES, formatCaptureDate } from './settings.js';
import { renderMetadataHeaderCanvas } from './stitcher.js';

/**
 * Analisa as últimas linhas de pixels de uma página candidata do PDF para encontrar
 * a linha horizontal com menor variação de cor (espaço em branco entre linhas de texto),
 * evitando cortar palavras ou elementos ao meio (Smart Page Splitting).
 */
export function findSmartSplitOffset(ctx, width, candidateHeight, searchWindow = 72) {
  const scanH = Math.min(searchWindow, Math.floor(candidateHeight * 0.25));
  if (scanH < 8 || width < 4) return candidateHeight;

  const startY = Math.max(1, candidateHeight - scanH);
  let imageData;
  try {
    imageData = ctx.getImageData(0, startY, width, scanH);
  } catch {
    return candidateHeight;
  }

  const pixels = new Uint32Array(imageData.data.buffer);
  let bestRowOffset = scanH - 1;
  let minTransitions = Infinity;

  // Percorre de baixo para cima procurando a linha mais uniforme
  for (let row = scanH - 1; row >= 0; row--) {
    const rowStart = row * width;
    let transitions = 0;
    for (let x = 1; x < width; x++) {
      const p1 = pixels[rowStart + x - 1];
      const p2 = pixels[rowStart + x];
      if (p1 !== p2 && hasNoticeableColorDiff(p1, p2)) {
        transitions++;
        if (transitions >= minTransitions) break;
      }
    }
    if (transitions < minTransitions) {
      minTransitions = transitions;
      bestRowOffset = row;
      if (transitions <= 1) break; // Linha praticamente uniforme encontrada
    }
  }

  return startY + bestRowOffset;
}

function hasNoticeableColorDiff(c1, c2) {
  const r1 = c1 & 0xff;
  const g1 = (c1 >>> 8) & 0xff;
  const b1 = (c1 >>> 16) & 0xff;
  const r2 = c2 & 0xff;
  const g2 = (c2 >>> 8) & 0xff;
  const b2 = c2 >>> 16 & 0xff;
  return Math.abs(r1 - r2) > 6 || Math.abs(g1 - g2) > 6 || Math.abs(b1 - b2) > 6;
}

function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const binStr = atob(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

function escapePdfString(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Monta um arquivo PDF 1.4 binário nativo com imagens JPEG de alta qualidade
 * e anotações de links clicáveis (/Subtype /Link) sem depender de bibliotecas externas.
 */
function buildPdfBinary(pages) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0]; // Índice 0 reservado pelo formato xref
  let currentOffset = 0;

  const writeStr = (str) => {
    const bytes = encoder.encode(str);
    chunks.push(bytes);
    currentOffset += bytes.length;
  };

  const writeBytes = (bytes) => {
    chunks.push(bytes);
    currentOffset += bytes.length;
  };

  let nextObjId = 1;
  const allocObjId = () => nextObjId++;

  const catalogObjId = allocObjId(); // 1
  const pagesObjId = allocObjId(); // 2

  const pageEntries = pages.map((page) => {
    const pageObjId = allocObjId();
    const contentObjId = allocObjId();
    const imageObjId = allocObjId();
    const annotObjIds = (page.links || []).map(() => allocObjId());
    return {
      ...page,
      pageObjId,
      contentObjId,
      imageObjId,
      annotObjIds
    };
  });

  // Cabeçalho PDF 1.4 com marcador binário
  writeStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  const startObj = (id) => {
    offsets[id] = currentOffset;
    writeStr(`${id} 0 obj\n`);
  };

  const endObj = () => {
    writeStr('\nendobj\n');
  };

  // 1: Catalog
  startObj(catalogObjId);
  writeStr(`<< /Type /Catalog /Pages ${pagesObjId} 0 R >>`);
  endObj();

  // 2: Pages Tree
  const kidsRefs = pageEntries.map((p) => `${p.pageObjId} 0 R`).join(' ');
  startObj(pagesObjId);
  writeStr(`<< /Type /Pages /Kids [ ${kidsRefs} ] /Count ${pageEntries.length} >>`);
  endObj();

  // Cada página + conteúdo + XObject de imagem + Anotações de links
  for (const p of pageEntries) {
    const wPt = Number(p.pageWidthPt.toFixed(2));
    const hPt = Number(p.pageHeightPt.toFixed(2));
    const drawX = Number(p.drawXPt.toFixed(2));
    const drawY = Number((p.pageHeightPt - p.drawYPt - p.drawHeightPt).toFixed(2));
    const drawW = Number(p.drawWidthPt.toFixed(2));
    const drawH = Number(p.drawHeightPt.toFixed(2));

    const annotsPart = p.annotObjIds.length
      ? `/Annots [ ${p.annotObjIds.map((id) => `${id} 0 R`).join(' ')} ]`
      : '';

    startObj(p.pageObjId);
    writeStr(
      `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [ 0 0 ${wPt} ${hPt} ] ` +
        `/Resources << /XObject << /Im1 ${p.imageObjId} 0 R >> >> ` +
        `/Contents ${p.contentObjId} 0 R ${annotsPart} >>`
    );
    endObj();

    const contentStream = `q\n${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm\n/Im1 Do\nQ\n`;
    const contentBytes = encoder.encode(contentStream);
    startObj(p.contentObjId);
    writeStr(`<< /Length ${contentBytes.length} >>\nstream\n`);
    writeBytes(contentBytes);
    writeStr('\nendstream');
    endObj();

    startObj(p.imageObjId);
    writeStr(
      `<< /Type /XObject /Subtype /Image /Width ${p.pixelWidth} /Height ${p.pixelHeight} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpegBytes.length} >>\nstream\n`
    );
    writeBytes(p.jpegBytes);
    writeStr('\nendstream');
    endObj();

    for (let i = 0; i < p.annotObjIds.length; i++) {
      const annotId = p.annotObjIds[i];
      const link = p.links[i];
      const x1 = Number(link.x1Pt.toFixed(2));
      const y1 = Number(link.y1Pt.toFixed(2));
      const x2 = Number(link.x2Pt.toFixed(2));
      const y2 = Number(link.y2Pt.toFixed(2));
      const safeUrl = escapePdfString(link.url);

      startObj(annotId);
      writeStr(
        `<< /Type /Annot /Subtype /Link /Border [ 0 0 0 ] ` +
          `/Rect [ ${x1} ${y1} ${x2} ${y2} ] ` +
          `/A << /Type /Action /S /URI /URI (${safeUrl}) >> >>`
      );
      endObj();
    }
  }

  // Tabela xref
  const xrefOffset = currentOffset;
  const totalObjs = nextObjId;
  writeStr(`xref\n0 ${totalObjs}\n`);
  writeStr('0000000000 65535 f \n');
  for (let id = 1; id < totalObjs; id++) {
    const offStr = String(offsets[id] || 0).padStart(10, '0');
    writeStr(`${offStr} 00000 n \n`);
  }

  writeStr(
    `trailer\n<< /Size ${totalObjs} /Root ${catalogObjId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  return new Blob(chunks, { type: 'application/pdf' });
}

/**
 * Exporta as imagens/fatias capturadas para PDF com suporte completo a:
 * - Smart Page Splitting (sem cortar linhas de texto ao meio)
 * - Links clicáveis ativos (/Subtype /Link)
 * - Barra de cabeçalho opcional com URL e Data/Hora da captura
 * - Página única contínua ('full') ou paginado ('a4', 'letter', 'legal', etc.)
 */
export async function exportCaptureToPDF({
  images, // Array de { img/canvas, width, height }
  record,
  settings,
  onProgress
}) {
  if (!images || !images.length) {
    throw new Error('Nenhuma imagem disponível para exportar o PDF.');
  }

  const scaleMultiplier = record?.scaleMultiplier || window.devicePixelRatio || 1;
  const paperKey = settings?.pdfPaperSize || 'a4';
  const isFullSinglePage = paperKey === 'full' || !PAPER_SIZES[paperKey];
  const smartSplit = Boolean(settings?.pdfSmartSplit) && !isFullSinglePage;
  const activeLinks = Boolean(settings?.pdfActiveLinks);
  const addUrlAndDate = Boolean(settings?.pdfHeaderUrlDate);

  const physWidth = images[0].width;
  const allLinks = [];
  let headerCanvasInfo = null;
  let headerOffsetPhysY = 0;

  if (addUrlAndDate) {
    const dateText = formatCaptureDate(record?.createdAt || Date.now(), settings?.pdfDateFormat || 'br');
    headerCanvasInfo = renderMetadataHeaderCanvas({
      width: physWidth,
      scaleMultiplier,
      url: record?.url || '',
      title: record?.title || '',
      dateText,
      theme: 'dark'
    });
    headerOffsetPhysY = headerCanvasInfo.physicalHeight;
    if (activeLinks && headerCanvasInfo.urlLinkRect) {
      const r = headerCanvasInfo.urlLinkRect;
      allLinks.push({
        x: r.x * scaleMultiplier,
        y: r.y * scaleMultiplier,
        width: r.width * scaleMultiplier,
        height: r.height * scaleMultiplier,
        url: r.url
      });
    }
  }

  if (activeLinks && Array.isArray(record?.metadata?.links)) {
    for (const l of record.metadata.links) {
      if (!l?.url || !l.width || !l.height) continue;
      allLinks.push({
        x: l.x * scaleMultiplier,
        y: l.y * scaleMultiplier + headerOffsetPhysY,
        width: l.width * scaleMultiplier,
        height: l.height * scaleMultiplier,
        url: l.url
      });
    }
  }

  // Monta uma lista virtual de fontes verticais (header opcional + fatias da captura)
  const sources = [];
  let totalPhysHeight = 0;
  if (headerCanvasInfo) {
    sources.push({
      el: headerCanvasInfo.canvas,
      width: physWidth,
      height: headerCanvasInfo.physicalHeight,
      top: 0,
      bottom: headerCanvasInfo.physicalHeight
    });
    totalPhysHeight += headerCanvasInfo.physicalHeight;
  }
  for (const item of images) {
    const el = item.canvas || item.img || item;
    const h = item.height;
    sources.push({
      el,
      width: item.width,
      height: h,
      top: totalPhysHeight,
      bottom: totalPhysHeight + h
    });
    totalPhysHeight += h;
  }

  const marginPt = isFullSinglePage ? 0 : 18;
  let pageWidthPt;
  let pageHeightPt;

  if (isFullSinglePage) {
    // Em modo página contínua, converte dimensões lógicas para pontos (limitando a 14.400pt do padrão PDF)
    let wPt = physWidth / scaleMultiplier;
    let hPt = totalPhysHeight / scaleMultiplier;
    const maxPt = 14400;
    if (wPt > maxPt) {
      const ratio = maxPt / wPt;
      wPt = maxPt;
      hPt = Math.floor(hPt * ratio);
    }
    if (hPt > maxPt) {
      hPt = maxPt;
    }
    pageWidthPt = Math.max(72, wPt);
    pageHeightPt = Math.max(72, hPt);
  } else {
    const spec = PAPER_SIZES[paperKey] || PAPER_SIZES.a4;
    pageWidthPt = spec.widthPt;
    pageHeightPt = spec.heightPt;
  }

  const printableWidthPt = pageWidthPt - marginPt * 2;
  const printableHeightPt = pageHeightPt - marginPt * 2;
  const ptPerPhysPixel = printableWidthPt / physWidth;
  const maxSlicePhysHeight = isFullSinglePage
    ? Math.min(totalPhysHeight, 16384)
    : Math.max(120, Math.floor(printableHeightPt / ptPerPhysPixel));

  const pagesOutput = [];
  let cursorPhysY = 0;

  while (cursorPhysY < totalPhysHeight - 1) {
    if (onProgress) {
      onProgress(Math.min(0.95, cursorPhysY / totalPhysHeight));
      await new Promise((r) => setTimeout(r, 0));
    }

    const remaining = totalPhysHeight - cursorPhysY;
    let candidateH = Math.min(remaining, maxSlicePhysHeight);

    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = physWidth;
    pageCanvas.height = candidateH;
    const ctx = pageCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, physWidth, candidateH);

    // Desenha todas as fontes que intersectam [cursorPhysY, cursorPhysY + candidateH]
    const sliceBottom = cursorPhysY + candidateH;
    for (const src of sources) {
      if (src.bottom <= cursorPhysY || src.top >= sliceBottom) continue;
      const overlapTop = Math.max(cursorPhysY, src.top);
      const overlapBottom = Math.min(sliceBottom, src.bottom);
      const overlapH = overlapBottom - overlapTop;
      const srcY = overlapTop - src.top;
      const dstY = overlapTop - cursorPhysY;
      ctx.drawImage(src.el, 0, srcY, physWidth, overlapH, 0, dstY, physWidth, overlapH);
    }

    // Se houver mais páginas a seguir e o Smart Page Splitting estiver ativo, ajusta a altura de corte
    let finalSliceH = candidateH;
    if (smartSplit && cursorPhysY + candidateH < totalPhysHeight - 10) {
      const smartH = findSmartSplitOffset(ctx, physWidth, candidateH, Math.round(68 * scaleMultiplier));
      if (smartH > candidateH * 0.65 && smartH < candidateH) {
        finalSliceH = smartH;
      }
    }

    let exportCanvas = pageCanvas;
    if (finalSliceH !== candidateH) {
      exportCanvas = document.createElement('canvas');
      exportCanvas.width = physWidth;
      exportCanvas.height = finalSliceH;
      exportCanvas.getContext('2d').drawImage(pageCanvas, 0, 0, physWidth, finalSliceH, 0, 0, physWidth, finalSliceH);
    }

    const jpegDataUrl = exportCanvas.toDataURL('image/jpeg', 0.92);
    const jpegBytes = dataUrlToUint8Array(jpegDataUrl);

    const drawWidthPt = printableWidthPt;
    const drawHeightPt = finalSliceH * ptPerPhysPixel;
    const actualPageHeightPt = isFullSinglePage ? drawHeightPt + marginPt * 2 : pageHeightPt;

    // Filtra e converte os links que caem nesta página para coordenadas PDF (origem no canto inferior esquerdo)
    const pageTopPhys = cursorPhysY;
    const pageBottomPhys = cursorPhysY + finalSliceH;
    const pageLinks = [];

    if (activeLinks && allLinks.length) {
      for (const link of allLinks) {
        const lTop = link.y;
        const lBottom = link.y + link.height;
        if (lBottom <= pageTopPhys || lTop >= pageBottomPhys) continue;

        const clippedTop = Math.max(pageTopPhys, lTop) - pageTopPhys;
        const clippedBottom = Math.min(pageBottomPhys, lBottom) - pageTopPhys;
        const clippedHeight = clippedBottom - clippedTop;
        if (clippedHeight < 3) continue;

        const x1Pt = marginPt + link.x * ptPerPhysPixel;
        const x2Pt = marginPt + (link.x + link.width) * ptPerPhysPixel;
        const topFromPageTopPt = marginPt + clippedTop * ptPerPhysPixel;
        const bottomFromPageTopPt = marginPt + clippedBottom * ptPerPhysPixel;

        pageLinks.push({
          x1Pt,
          y1Pt: actualPageHeightPt - bottomFromPageTopPt,
          x2Pt,
          y2Pt: actualPageHeightPt - topFromPageTopPt,
          url: link.url
        });
      }
    }

    pagesOutput.push({
      pageWidthPt,
      pageHeightPt: actualPageHeightPt,
      drawXPt: marginPt,
      drawYPt: marginPt,
      drawWidthPt,
      drawHeightPt,
      pixelWidth: physWidth,
      pixelHeight: finalSliceH,
      jpegBytes,
      links: pageLinks
    });

    cursorPhysY += finalSliceH;
  }

  if (onProgress) onProgress(1);
  return buildPdfBinary(pagesOutput);
}
