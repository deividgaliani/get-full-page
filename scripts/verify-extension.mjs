import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  formatFilename,
  formatCaptureDate,
  sanitizeSubdirectory
} from '../src/lib/settings.js';
import { findSmartSplitOffset } from '../src/lib/pdf-exporter.js';

const rootDir = process.cwd();

console.log('1. Validando manifest.json e arquivos referenciados...');
const manifestPath = path.join(rootDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.manifest_version, 3, 'Deve ser Manifest V3');
assert.ok(manifest.action?.default_popup, 'Action default_popup deve existir');
assert.ok(manifest.background?.service_worker, 'Service worker deve existir');

const filesToVerify = [
  manifest.action.default_popup,
  manifest.background.service_worker,
  manifest.options_page,
  'src/content/capturer.js',
  'src/viewer/viewer.html',
  'src/viewer/viewer.js',
  'src/editor/editor.js',
  'src/lib/db.js',
  'src/lib/settings.js',
  'src/lib/stitcher.js',
  'src/lib/pdf-exporter.js'
];

for (const rel of filesToVerify) {
  const full = path.join(rootDir, rel);
  assert.ok(fs.existsSync(full), `Arquivo obrigatório ausente: ${rel}`);
}

console.log('2. Validando dimensões reais dos ícones PNG no cabeçalho IHDR...');
for (const [sizeStr, iconRel] of Object.entries(manifest.icons)) {
  const expectedSize = Number(sizeStr);
  const buf = fs.readFileSync(path.join(rootDir, iconRel));
  assert.equal(buf[0], 0x89, 'Assinatura PNG inválida');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(width, expectedSize, `Largura do ícone ${iconRel} deve ser ${expectedSize}`);
  assert.equal(height, expectedSize, `Altura do ícone ${iconRel} deve ser ${expectedSize}`);
}

console.log('3. Validando sintaxe JavaScript de todos os módulos com node --check...');
const jsFiles = filesToVerify.filter((f) => f.endsWith('.js'));
for (const jsRel of jsFiles) {
  execFileSync(process.execPath, ['--check', path.join(rootDir, jsRel)]);
}

console.log('4. Validando conformidade CSP e Modern Web Guidance nos arquivos HTML...');
const htmlFiles = ['src/popup/popup.html', 'src/viewer/viewer.html', 'src/options/options.html'];
for (const htmlRel of htmlFiles) {
  const html = fs.readFileSync(path.join(rootDir, htmlRel), 'utf8');
  assert.ok(
    html.includes('<meta name="color-scheme" content="light dark">'),
    `${htmlRel} deve declarar <meta name="color-scheme" content="light dark">`
  );
  assert.ok(!/\son\w+\s*=/i.test(html), `${htmlRel} não deve conter handlers inline (CSP)`);
}

console.log('5. Testando algoritmo Smart Page Splitting e geração de nomes de arquivos...');
// Simula um canvas de 100x200 onde a linha 170 é toda branca (espaço entre parágrafos)
// e as demais linhas possuem texto (pixels escuros alternados)
const fakeWidth = 100;
const fakeHeight = 200;
const mockCtx = {
  getImageData(_x, startY, w, h) {
    const buf = new Uint32Array(w * h);
    for (let row = 0; row < h; row++) {
      const absY = startY + row;
      const isBlankRow = absY === 172;
      for (let col = 0; col < w; col++) {
        if (isBlankRow) {
          buf[row * w + col] = 0xffffffff; // Branco uniforme
        } else {
          buf[row * w + col] = col % 2 === 0 ? 0xffffffff : 0xff000000; // Texto simulado
        }
      }
    }
    return { data: new Uint8ClampedArray(buf.buffer) };
  }
};

const smartCutY = findSmartSplitOffset(mockCtx, fakeWidth, fakeHeight, 50);
assert.equal(smartCutY, 172, 'Smart Page Splitting deve encontrar exatamente a linha em branco (y=172)');

const fnResult = formatFilename({
  template: 'captura-{domain}-{title}-{date}',
  record: {
    url: 'https://www.exemplo.com.br/produtos',
    title: 'Minha Página Teste',
    createdAt: new Date('2026-11-01T12:00:00Z').getTime()
  },
  ext: 'pdf'
});
assert.ok(fnResult.startsWith('captura-exemplo.com.br-Minha-P'), `Filename inesperado: ${fnResult}`);
assert.ok(fnResult.endsWith('.pdf'), 'Extensão deve terminar em .pdf');
assert.equal(sanitizeSubdirectory('C:\\ pastas/../minhas_capturas/ '), 'pastas/minhas_capturas');
assert.ok(formatCaptureDate(Date.now(), 'br').includes('/'), 'Formato de data BR válido');

console.log('✅ Todos os testes e validações passaram com sucesso!');
