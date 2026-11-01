import { loadSettings, saveSettings } from '../lib/settings.js';

const viewModes = document.getElementById('view-modes');
const viewProgress = document.getElementById('view-progress');
const viewError = document.getElementById('view-error');

const progressStatus = document.getElementById('progress-status');
const progressPct = document.getElementById('progress-pct');
const progressBar = document.getElementById('progress-bar');
const progressSub = document.getElementById('progress-sub');

const errorTitle = document.getElementById('error-title');
const errorDesc = document.getElementById('error-desc');

const chkAutoStart = document.getElementById('chk-auto-start');
const btnFiles = document.getElementById('btn-files');
const btnOptions = document.getElementById('btn-options');
const btnStopCapture = document.getElementById('btn-stop-capture');
const btnFallbackVisible = document.getElementById('btn-fallback-visible');
const btnErrorBack = document.getElementById('btn-error-back');

function showView(target) {
  [viewModes, viewProgress, viewError].forEach((v) => v.classList.add('hidden'));
  target.classList.remove('hidden');
}

function renderCaptureState(state) {
  if (!state) return;
  if (state.status === 'capturing' || state.status === 'saving') {
    showView(viewProgress);
    const pct = Math.min(100, Math.max(2, Math.round((state.progress || 0) * 100)));
    progressPct.textContent = `${pct}%`;
    progressBar.style.width = `${pct}%`;
    progressStatus.textContent = state.message || 'Capturando página...';
    if (state.sliceCount && state.sliceCount > 1) {
      progressSub.textContent = `Página longa detectada (${state.sliceCount} fatias integradas sem perda)...`;
    } else {
      progressSub.textContent = 'Você pode parar a qualquer momento em páginas de scroll infinito.';
    }
  } else if (state.status === 'error') {
    showView(viewError);
    errorTitle.textContent = 'Erro durante a captura';
    errorDesc.textContent = state.error || 'Não foi possível acessar o conteúdo desta página.';
  } else if (state.status === 'idle' && state.lastCaptureId) {
    window.close();
  }
}

async function startCaptureMode(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showView(viewError);
    errorDesc.textContent = 'Nenhuma aba ativa encontrada.';
    return;
  }

  if (mode === 'picker') {
    await chrome.runtime.sendMessage({
      type: 'GFP_START_CAPTURE_CMD',
      mode: 'picker',
      tab
    });
    window.close();
    return;
  }

  showView(viewProgress);
  progressPct.textContent = '2%';
  progressBar.style.width = '4%';
  progressStatus.textContent =
    mode === 'cdp'
      ? 'Iniciando captura instantânea CDP...'
      : mode === 'visible'
      ? 'Capturando área visível...'
      : 'Preparando rolagem inteligente...';

  const resp = await chrome.runtime.sendMessage({
    type: 'GFP_START_CAPTURE_CMD',
    mode,
    tab
  });

  if (!resp?.ok) {
    showView(viewError);
    errorDesc.textContent = resp?.error || 'Esta página restringe a execução de scripts.';
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'GFP_STATE_BROADCAST') {
    renderCaptureState(msg.state);
  }
});

document.querySelectorAll('.mode-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode || 'scroll';
    startCaptureMode(mode);
  });
});

btnStopCapture.addEventListener('click', async () => {
  btnStopCapture.disabled = true;
  btnStopCapture.textContent = 'Finalizando e gerando imagem...';
  await chrome.runtime.sendMessage({ type: 'GFP_STOP_CAPTURE_CMD' });
});

btnFallbackVisible.addEventListener('click', () => {
  startCaptureMode('visible');
});

btnErrorBack.addEventListener('click', () => {
  showView(viewModes);
});

btnFiles.addEventListener('click', async () => {
  const url = chrome.runtime.getURL('src/viewer/viewer.html');
  await chrome.tabs.create({ url });
  window.close();
});

btnOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chkAutoStart.addEventListener('change', async () => {
  await saveSettings({ autoStartCapture: chkAutoStart.checked });
});

(async function initPopup() {
  const settings = await loadSettings();
  chkAutoStart.checked = Boolean(settings.autoStartCapture);

  const { captureState } = await chrome.storage.session.get('captureState');
  if (captureState?.status === 'capturing' || captureState?.status === 'saving') {
    renderCaptureState(captureState);
    return;
  }

  if (settings.autoStartCapture) {
    startCaptureMode(settings.defaultCaptureMode || 'scroll');
  }
})();
