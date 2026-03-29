# Video Downloader

App desktop para extrair links diretos de vídeos via `yt-dlp`. Suporta YouTube, Instagram, TikTok, Facebook, LinkedIn, X (Twitter) e Threads.

Construído com **Electron + React** via `electron-vite`.

---

## Instalação do app (usuário final)

Baixe o `.dmg` mais recente na página de releases, abra e arraste para a pasta **Aplicativos**.

> Nenhuma dependência extra é necessária — o `yt-dlp` já vem bundlado dentro do app.
>
> **Threads:** requer o [Google Chrome](https://www.google.com/chrome) instalado.

---

## Desenvolvimento local

### Pré-requisitos

- [Node.js](https://nodejs.org) 18+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) instalado no sistema

```bash
# macOS com Homebrew
brew install yt-dlp

# ou com pip
pip install yt-dlp
```

### Rodar em modo dev

```bash
git clone <repo>
cd video-downloader
npm install
npm run dev
```

O app Electron abre automaticamente com **hot reload** e **DevTools** habilitados.

---

## Gerar o instalador (.dmg / .exe)

### 1. Baixe o binário do yt-dlp

Esse passo só precisa ser feito uma vez (ou quando quiser atualizar o yt-dlp bundlado).

**macOS:**
```bash
mkdir -p resources/bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos \
  -o resources/bin/yt-dlp
chmod +x resources/bin/yt-dlp
```

**Windows** (no PowerShell):
```powershell
New-Item -ItemType Directory -Force -Path resources\bin
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" `
  -OutFile "resources\bin\yt-dlp.exe"
```

### 2. Gere o instalador

```bash
npm run dist
```

O arquivo gerado fica em `dist/`:
- `dist/Video Downloader-x.x.x-arm64.dmg` (macOS Apple Silicon)
- `dist/Video Downloader-x.x.x.dmg` (macOS Intel)
- `dist/Video Downloader Setup x.x.x.exe` (Windows)

---

## Scripts disponíveis

| Comando | O que faz |
|---|---|
| `npm run dev` | Abre o app em modo desenvolvimento com hot reload |
| `npm run build` | Compila o código para `out/` sem empacotar |
| `npm run dist` | Compila + gera o instalador final em `dist/` |
| `npm run pack` | Compila + gera o app descompactado em `dist/` (sem instalador, útil para testar) |

---

## Como funciona

1. Cole a URL do vídeo e clique em **Analisar**
2. O app consulta o `yt-dlp` localmente para listar os formatos disponíveis
3. Escolha a qualidade desejada
4. O `yt-dlp` obtém o link direto de download
5. O download inicia direto da plataforma para o seu dispositivo — nada passa por servidor externo

**Threads** usa um fluxo diferente: o app abre o Chrome em modo headless e intercepta a requisição de rede para capturar a URL do vídeo.

---

## Plataformas suportadas

| Plataforma | Método |
|---|---|
| YouTube | yt-dlp |
| Instagram | yt-dlp |
| TikTok | yt-dlp |
| Facebook | yt-dlp |
| LinkedIn | yt-dlp |
| X (Twitter) | yt-dlp |
| Threads | Puppeteer + Chrome headless |
| Qualquer site suportado pelo yt-dlp | yt-dlp |

---

## Estrutura do projeto

```
src/
  main/index.js       ← processo principal (Node.js): yt-dlp, Puppeteer, IPC
  preload/index.js    ← ponte segura entre main e renderer (contextBridge)
  renderer/
    index.html
    src/
      main.jsx        ← entrada React
      App.jsx         ← interface completa
      App.css         ← estilos
resources/
  bin/
    yt-dlp            ← binário bundlado (não commitado no git)
electron.vite.config.mjs
package.json
```

> O binário `resources/bin/yt-dlp` não deve ser commitado no git (já está no `.gitignore`).
> Cada desenvolvedor ou pipeline de CI deve baixá-lo antes de rodar `npm run dist`.
