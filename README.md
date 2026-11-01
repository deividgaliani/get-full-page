# GetFullPage — Captura de Página Inteira & Editor Pro

Extensão Chrome **Manifest V3** completa para captura de páginas inteiras, exportação de PDF inteligente e edição/anotação visual — **100% local, sem paywalls, sem telemetria e sem limites artificiais**.

## Principais Recursos

| Recurso | Descrição |
| :--- | :--- |
| **Editor de Anotações Completo** | Exportação direta (PNG, JPG, WebP, PDF e Clipboard) com Recorte, Blur/Pixelização, Setas, Formas, Texto e Passos Numerados |
| **Smart Page Splitting no PDF** | Analisa as linhas de pixels na quebra de página (`findSmartSplitOffset`) para evitar cortar linhas de texto ao meio |
| **Links Clicáveis Ativos no PDF** | Mapeia todas as tags `<a href>` da página e gera anotações `/Subtype /Link` nativas no PDF exportado |
| **Cabeçalho e Molduras de Navegador** | Cabeçalho opcional com URL + Data/Hora e molduras estilo macOS, Windows, Barra Escura ou Barra Clara |
| **Template Personalizado de Nome de Arquivo** | Máscaras dinâmicas com `{domain}`, `{title}`, `{url}`, `{path}`, `{date}`, `{time}` e `{timestamp}` |
| **Captura Instantânea sem Rolagem (CDP)** | Renderiza a página completa direto pela engine do navegador (`Page.captureScreenshot` via `chrome.debugger`) |
| **Seletor Visual de Container / Elemento (Picker)** | Detecção automática de containers roláveis + Seletor Visual Interativo na página para painéis específicos |
| **Parada Manual em Feeds de Scroll Infinito** | Botão "Parar Aqui e Finalizar" em tempo real durante a captura |
| **Continuidade em Background** | Costura em segundo plano via `OffscreenCanvas` no Service Worker mesmo se o popup for fechado |
| **Armazenamento Local Moderno** | Histórico persistente em `IndexedDB` com suporte a `Blob` nativo e edições não-destrutivas |

## Como Instalar / Carregar no Google Chrome

1. Abra o Chrome e acesse `chrome://extensions/`.
2. Ative a chave **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** (*Load unpacked*).
4. Selecione a pasta raiz deste repositório: `c:\Users\deivi\repositorios\get-full-page`.

## Atalhos de Teclado

- `Alt + Shift + P`: Abre o painel rápido de captura.
- `Alt + Shift + V`: Captura imediatamente a área visível.
- `Ctrl + E` (no Visualizador): Abre/fecha o **Editor Pro**.
- `Ctrl + C` (no Visualizador/Editor): Copia a imagem (com ou sem edições) para a área de transferência.
- `Ctrl + S` (no Visualizador/Editor): Baixa a imagem.

## Scripts de Desenvolvimento

```bash
# Regerar ícones PNG (16x16, 48x48, 128x128)
npm run icons

# Executar suíte de verificação e testes unitários
npm test
```
