(() => {
  if (window.__GFP_CONTENT_INSTALLED__) {
    return;
  }
  window.__GFP_CONTENT_INSTALLED__ = true;

  let stopRequested = false;
  let pickerActive = false;
  let pickerCleanup = null;

  class StyleGuard {
    constructor() {
      this.savedStyles = [];
      this.injectedStyleEl = null;
      this.hiddenFixedEls = [];
    }

    applyGlobalCaptureStyles(targetScrollEl) {
      const style = document.createElement('style');
      style.id = '__gfp_capture_styles__';
      style.textContent = `
        *, *::before, *::after {
          transition: none !important;
          transition-delay: 0s !important;
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          scroll-behavior: auto !important;
        }
        html, body, * {
          scrollbar-width: none !important;
        }
        html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar {
          width: 0 !important;
          height: 0 !important;
          display: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
      this.injectedStyleEl = style;

      // Força imagens com loading="lazy" a carregarem imediatamente
      document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
        img.setAttribute('loading', 'eager');
      });

      if (targetScrollEl && targetScrollEl !== window && targetScrollEl !== document.documentElement) {
        this.saveAndSetStyle(targetScrollEl, { scrollBehavior: 'auto' });
      }
    }

    saveAndSetStyle(el, stylePatch) {
      if (!el || !el.style) return;
      this.savedStyles.push({ el, cssText: el.style.cssText });
      for (const [prop, val] of Object.entries(stylePatch)) {
        const cssProp = prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        el.style.setProperty(cssProp, val, 'important');
      }
    }

    hideFloatingElementsAfterFirstSlice(isFirstSlice, rootContainer) {
      if (isFirstSlice) {
        this.restoreHiddenFixed();
        return;
      }
      if (this.hiddenFixedEls.length > 0) return;

      const allElements = document.querySelectorAll('*');
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      for (const el of allElements) {
        if (el.id === '__gfp_picker_overlay__' || el.id === '__gfp_picker_hud__') continue;
        if (rootContainer && rootContainer === el) continue;

        const cs = window.getComputedStyle(el);
        const pos = cs.position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        // Não oculta um container modal que ocupa a tela inteira e contém o próprio scroll
        if (pos === 'fixed' && rect.width >= vw * 0.9 && rect.height >= vh * 0.9) {
          if (rootContainer && el.contains(rootContainer)) continue;
        }

        this.hiddenFixedEls.push({ el, prevVisibility: el.style.getPropertyValue('visibility'), prevPriority: el.style.getPropertyPriority('visibility') });
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    }

    restoreHiddenFixed() {
      while (this.hiddenFixedEls.length) {
        const { el, prevVisibility, prevPriority } = this.hiddenFixedEls.pop();
        if (prevVisibility) {
          el.style.setProperty('visibility', prevVisibility, prevPriority || '');
        } else {
          el.style.removeProperty('visibility');
        }
      }
    }

    restoreAll() {
      this.restoreHiddenFixed();
      while (this.savedStyles.length) {
        const { el, cssText } = this.savedStyles.pop();
        if (el && el.style) {
          el.style.cssText = cssText;
        }
      }
      if (this.injectedStyleEl) {
        this.injectedStyleEl.remove();
        this.injectedStyleEl = null;
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function detectBackgroundColor() {
    const candidates = [document.body, document.documentElement].filter(Boolean);
    for (const el of candidates) {
      const bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/^rgba\(\d+,\s*\d+,\s*\d+,\s*0\)$/.test(bg)) {
        return bg;
      }
    }
    return '#ffffff';
  }

  function findBestScrollTarget(customElement = null) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docEl = document.documentElement;
    const body = document.body;

    if (customElement && customElement instanceof Element) {
      const rect = customElement.getBoundingClientRect();
      const isScrollable = customElement.scrollHeight > customElement.clientHeight + 12;
      return {
        mode: isScrollable ? 'container' : 'element',
        el: customElement,
        rect: {
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          width: Math.min(vw, rect.width),
          height: Math.min(vh, rect.height)
        },
        scrollWidth: isScrollable ? customElement.scrollWidth : Math.round(rect.width),
        scrollHeight: isScrollable ? customElement.scrollHeight : Math.round(rect.height)
      };
    }

    const docScrollHeight = Math.max(
      docEl ? docEl.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      docEl ? docEl.offsetHeight : 0,
      body ? body.offsetHeight : 0
    );
    const docScrollWidth = Math.max(
      docEl ? docEl.clientWidth : vw,
      body ? body.clientWidth : vw
    );

    const rootOverflowY = docEl ? window.getComputedStyle(docEl).overflowY : 'visible';
    const bodyOverflowY = body ? window.getComputedStyle(body).overflowY : 'visible';
    const rootClipsScroll = rootOverflowY === 'hidden' && bodyOverflowY === 'hidden';

    // Se a janela principal tem rolagem significativa, usa a janela
    if (!rootClipsScroll && docScrollHeight > vh + 24) {
      // Verifica se body é quem rola diretamente
      const bodyScrollsDirectly =
        body &&
        (bodyOverflowY === 'auto' || bodyOverflowY === 'scroll') &&
        body.scrollHeight > body.clientHeight + 20 &&
        docEl.scrollHeight <= vh + 10;

      return {
        mode: 'window',
        el: bodyScrollsDirectly ? body : window,
        rect: { left: 0, top: 0, width: vw, height: vh },
        scrollWidth: Math.max(vw, docScrollWidth),
        scrollHeight: docScrollHeight
      };
    }

    // Procura o maior container rolável visível (SPAs, dashboards, Notion, chats)
    let bestEl = null;
    let bestScore = 0;
    const walker = document.createTreeWalker(document.body || docEl, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;

    while (node) {
      if (node !== body && node !== docEl) {
        const cs = window.getComputedStyle(node);
        const oy = cs.overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cs.display !== 'none' && cs.visibility !== 'hidden') {
          const sh = node.scrollHeight;
          const ch = node.clientHeight;
          const cw = node.clientWidth;
          if (sh > ch + 20 && ch > 100 && cw > 120) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 120 && rect.height > 100 && rect.bottom > 0 && rect.top < vh) {
              const score = sh * Math.min(vw, rect.width);
              if (score > bestScore) {
                bestScore = score;
                bestEl = node;
              }
            }
          }
        }
      }
      node = walker.nextNode();
    }

    if (bestEl) {
      const rect = bestEl.getBoundingClientRect();
      return {
        mode: 'container',
        el: bestEl,
        rect: {
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          width: Math.min(vw - Math.max(0, rect.left), rect.width),
          height: Math.min(vh - Math.max(0, rect.top), rect.height)
        },
        scrollWidth: Math.max(Math.round(rect.width), bestEl.scrollWidth),
        scrollHeight: bestEl.scrollHeight
      };
    }

    return {
      mode: 'window',
      el: window,
      rect: { left: 0, top: 0, width: vw, height: vh },
      scrollWidth: vw,
      scrollHeight: Math.max(vh, docScrollHeight)
    };
  }

  function getScrollPos(targetEl) {
    if (targetEl === window) {
      return { x: window.scrollX || window.pageXOffset || 0, y: window.scrollY || window.pageYOffset || 0 };
    }
    return { x: targetEl.scrollLeft || 0, y: targetEl.scrollTop || 0 };
  }

  function setScrollPos(targetEl, x, y) {
    if (targetEl === window) {
      window.scrollTo(x, y);
    } else {
      targetEl.scrollLeft = x;
      targetEl.scrollTop = y;
    }
  }

  function collectVisibleLinks(targetInfo, currentScrollY, destYOffset) {
    const links = [];
    const anchors = document.querySelectorAll('a[href]');
    const viewLeft = targetInfo.rect.left;
    const viewTop = targetInfo.rect.top;
    const viewRight = viewLeft + targetInfo.rect.width;
    const viewBottom = viewTop + targetInfo.rect.height;

    for (const a of anchors) {
      const href = a.href;
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
      const rect = a.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      if (rect.bottom <= viewTop || rect.top >= viewBottom || rect.right <= viewLeft || rect.left >= viewRight) {
        continue;
      }

      const clippedLeft = Math.max(viewLeft, rect.left);
      const clippedTop = Math.max(viewTop, rect.top);
      const clippedRight = Math.min(viewRight, rect.right);
      const clippedBottom = Math.min(viewBottom, rect.bottom);

      links.push({
        url: href,
        x: Math.round(clippedLeft - viewLeft),
        y: Math.round(destYOffset + (clippedTop - viewTop)),
        width: Math.round(clippedRight - clippedLeft),
        height: Math.round(clippedBottom - clippedTop)
      });
    }
    return links;
  }

  async function warmupScroll(targetInfo) {
    const { el, scrollHeight, rect } = targetInfo;
    if (scrollHeight <= rect.height * 1.2) return;
    const maxWarmupHeight = Math.min(scrollHeight, rect.height * 12);
    const step = Math.max(300, Math.floor(rect.height * 0.9));
    for (let y = step; y <= maxWarmupHeight; y += step) {
      if (stopRequested) break;
      setScrollPos(el, 0, y);
      await sleep(35);
    }
    setScrollPos(el, 0, 0);
    await sleep(80);
  }

  async function runScrollCapture(options = {}, customTargetEl = null) {
    stopRequested = false;
    const styleGuard = new StyleGuard();
    const targetInfo = findBestScrollTarget(customTargetEl);
    const origScroll = getScrollPos(targetInfo.el);
    const origWinScroll = getScrollPos(window);

    const scrollDelayMs = Math.max(60, Number(options.scrollDelayMs) || 160);
    const hideFixedSticky = options.hideFixedSticky !== false;
    const doWarmup = Boolean(options.warmupLazyLoad) && targetInfo.mode !== 'element';
    const canvasBg = detectBackgroundColor();

    try {
      styleGuard.applyGlobalCaptureStyles(targetInfo.el);

      if (targetInfo.mode === 'element') {
        targetInfo.el.scrollIntoView({ block: 'center', inline: 'nearest' });
        await sleep(150);
        const freshRect = targetInfo.el.getBoundingClientRect();
        const clipX = Math.max(0, freshRect.left);
        const clipY = Math.max(0, freshRect.top);
        const clipW = Math.min(window.innerWidth - clipX, freshRect.width);
        const clipH = Math.min(window.innerHeight - clipY, freshRect.height);

        const links = collectVisibleLinks(
          { rect: { left: clipX, top: clipY, width: clipW, height: clipH } },
          0,
          0
        );

        await chrome.runtime.sendMessage({
          type: 'GFP_CAPTURE_STEP',
          stepIndex: 0,
          progress: 1,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          totalWidth: Math.round(clipW),
          totalHeight: Math.round(clipH),
          destX: 0,
          destY: 0,
          clipX,
          clipY,
          clipWidth: clipW,
          clipHeight: clipH,
          canvasBg,
          links
        });

        await chrome.runtime.sendMessage({
          type: 'GFP_CAPTURE_DONE',
          finalHeight: Math.round(clipH),
          stoppedEarly: false
        });
        return;
      }

      if (doWarmup) {
        await warmupScroll(targetInfo);
      }

      const viewportH = Math.round(targetInfo.rect.height);
      const viewportW = Math.round(targetInfo.rect.width);
      // Overlap para evitar costuras nas bordas de barras fixas superiores
      const topOverlap = targetInfo.mode === 'window' && viewportH > 320 ? 120 : 40;
      const effectiveStep = Math.max(100, viewportH - topOverlap);

      let totalHeight = Math.max(viewportH, targetInfo.scrollHeight);
      const maxSafetyHeight = 65000;
      let cursorY = 0;
      let stepIndex = 0;
      let actualCapturedHeight = 0;

      while (cursorY < totalHeight && !stopRequested) {
        const isFirstSlice = stepIndex === 0;
        setScrollPos(targetInfo.el, 0, cursorY);

        if (hideFixedSticky) {
          styleGuard.hideFloatingElementsAfterFirstSlice(
            isFirstSlice,
            targetInfo.mode === 'container' ? targetInfo.el : null
          );
        }

        await sleep(scrollDelayMs);

        // Atualiza a altura total se a página tiver crescido dinamicamente (infinite scroll)
        const currentScrollPos = getScrollPos(targetInfo.el);
        const liveScrollHeight =
          targetInfo.mode === 'window'
            ? Math.max(
                document.documentElement?.scrollHeight || 0,
                document.body?.scrollHeight || 0,
                totalHeight
              )
            : Math.max(targetInfo.el.scrollHeight, totalHeight);

        if (liveScrollHeight > totalHeight && liveScrollHeight <= maxSafetyHeight) {
          totalHeight = liveScrollHeight;
        }

        const achievedY = currentScrollPos.y;
        const overlapOffset = isFirstSlice ? 0 : topOverlap;
        const clipX = targetInfo.rect.left;
        const clipY = targetInfo.rect.top + overlapOffset;
        const clipWidth = viewportW;
        const clipHeight = viewportH - overlapOffset;
        const destY = achievedY + overlapOffset;

        const progress = Math.min(0.99, (destY + clipHeight) / Math.max(1, totalHeight));
        const links = collectVisibleLinks(
          {
            rect: {
              left: clipX,
              top: clipY,
              width: clipWidth,
              height: clipHeight
            }
          },
          achievedY,
          destY
        );

        const stepResp = await chrome.runtime.sendMessage({
          type: 'GFP_CAPTURE_STEP',
          stepIndex,
          progress,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          totalWidth: viewportW,
          totalHeight: Math.round(totalHeight),
          destX: 0,
          destY: Math.round(destY),
          clipX: Math.round(clipX),
          clipY: Math.round(clipY),
          clipWidth: Math.round(clipWidth),
          clipHeight: Math.round(clipHeight),
          canvasBg,
          links
        });

        actualCapturedHeight = Math.max(actualCapturedHeight, Math.round(destY + clipHeight));

        if (stepResp?.stop || stopRequested) {
          stopRequested = true;
          break;
        }

        // Se tentamos rolar e a posição real não avançou, chegamos ao fim real do container
        if (!isFirstSlice && achievedY + viewportH >= totalHeight - 2) {
          break;
        }
        if (stepIndex > 0 && achievedY === 0 && cursorY > 0) {
          break;
        }

        cursorY += effectiveStep;
        stepIndex++;
      }

      await chrome.runtime.sendMessage({
        type: 'GFP_CAPTURE_DONE',
        finalHeight: stopRequested ? actualCapturedHeight : Math.round(Math.min(totalHeight, actualCapturedHeight)),
        stoppedEarly: stopRequested
      });
    } catch (err) {
      await chrome.runtime.sendMessage({
        type: 'GFP_CAPTURE_ERROR',
        error: err?.message || String(err)
      });
    } finally {
      styleGuard.restoreAll();
      setScrollPos(targetInfo.el, origScroll.x, origScroll.y);
      setScrollPos(window, origWinScroll.x, origWinScroll.y);
    }
  }

  function startInteractivePicker(options = {}) {
    if (pickerActive && pickerCleanup) {
      pickerCleanup();
    }
    pickerActive = true;

    const overlay = document.createElement('div');
    overlay.id = '__gfp_picker_overlay__';
    Object.assign(overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483646',
      border: '2.5px solid #10b981',
      backgroundColor: 'rgba(16, 185, 129, 0.14)',
      borderRadius: '6px',
      boxShadow: '0 0 0 2px rgba(15, 23, 42, 0.45)',
      transition: 'all 60ms ease-out',
      display: 'none'
    });

    const hud = document.createElement('div');
    hud.id = '__gfp_picker_hud__';
    Object.assign(hud.style, {
      position: 'fixed',
      top: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      backgroundColor: '#0f172a',
      color: '#f8fafc',
      padding: '10px 16px',
      borderRadius: '999px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px',
      fontWeight: '600',
      boxShadow: '0 10px 25px rgba(0, 0, 0, 0.35)',
      border: '1px solid #334155',
      display: 'flex',
      alignItems: 'center',
      gap: '10px'
    });
    hud.innerHTML = `
      <span style="color:#10b981">●</span>
      <span id="__gfp_picker_label__">Passe o mouse e clique no container rolável ou elemento para capturar (Esc para cancelar)</span>
    `;

    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(hud);
    const labelEl = hud.querySelector('#__gfp_picker_label__');

    let hoveredEl = null;

    const onMouseMove = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === overlay || target === hud || hud.contains(target)) return;
      hoveredEl = target;
      const rect = target.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      const tag = target.tagName.toLowerCase();
      const cls = target.className && typeof target.className === 'string'
        ? `.${target.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      const isScrollable = target.scrollHeight > target.clientHeight + 12;
      const scrollBadge = isScrollable ? ` • Rolável (${target.scrollHeight}px)` : '';
      if (labelEl) {
        labelEl.textContent = `<${tag}${cls}> (${Math.round(rect.width)}×${Math.round(rect.height)}px${scrollBadge}) — Clique para capturar`;
      }
    };

    const cleanup = () => {
      pickerActive = false;
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      hud.remove();
      pickerCleanup = null;
    };

    const onClick = (e) => {
      if (!hoveredEl) return;
      e.preventDefault();
      e.stopPropagation();
      const chosen = hoveredEl;
      cleanup();
      chrome.runtime.sendMessage({
        type: 'GFP_PICKER_SELECTED',
        options
      });
      setTimeout(() => {
        runScrollCapture(options, chosen);
      }, 80);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
      }
    };

    pickerCleanup = cleanup;
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'GFP_PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'GFP_START_SCROLL_CAPTURE') {
      runScrollCapture(msg.options || {}, null);
      sendResponse({ started: true });
      return false;
    }

    if (msg.type === 'GFP_STOP_CAPTURE') {
      stopRequested = true;
      sendResponse({ stopping: true });
      return false;
    }

    if (msg.type === 'GFP_START_PICKER') {
      startInteractivePicker(msg.options || {});
      sendResponse({ pickerStarted: true });
      return false;
    }

    if (msg.type === 'GFP_COLLECT_PAGE_METRICS') {
      const target = findBestScrollTarget(null);
      const links = collectVisibleLinks(
        {
          rect: {
            left: 0,
            top: 0,
            width: Math.max(window.innerWidth, document.documentElement?.scrollWidth || 0),
            height: Math.max(window.innerHeight, document.documentElement?.scrollHeight || 0)
          }
        },
        0,
        0
      );
      sendResponse({
        width: Math.max(window.innerWidth, target.scrollWidth),
        height: Math.max(window.innerHeight, target.scrollHeight),
        devicePixelRatio: window.devicePixelRatio || 1,
        links
      });
      return false;
    }

    return false;
  });
})();
