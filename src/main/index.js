import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// ─── Cookies ──────────────────────────────────────────────────────────────────

const COOKIES_ARGS = process.platform === 'darwin'
  ? ['--cookies-from-browser', 'chrome:Default']
  : process.platform === 'win32'
    ? ['--cookies-from-browser', 'chrome']
    : []

// ─── yt-dlp ───────────────────────────────────────────────────────────────────

const YT_DLP = app.isPackaged
  ? join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  : 'yt-dlp'

const EXEC_ENV = {
  ...process.env,
  PATH: [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    `${process.env.HOME}/.local/bin`,
    process.env.PATH || '',
  ].join(':'),
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function getSettingsPath() {
  return join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  try {
    if (existsSync(getSettingsPath())) {
      return JSON.parse(readFileSync(getSettingsPath(), 'utf8'))
    }
  } catch {}
  return { folder: app.getPath('downloads'), maxQuality: 1080 }
}

function saveSettings(data) {
  writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2))
}

// ─── Threads extractor ────────────────────────────────────────────────────────

function isThreadsUrl(url) {
  return /threads\.(com|net)/i.test(url)
}

function findChrome() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
  return candidates.find(p => existsSync(p)) || null
}

async function extractThreadsUrl(url) {
  const chromePath = findChrome()
  if (!chromePath) throw new Error('Google Chrome não encontrado. Necessário para baixar do Threads.')

  const puppeteer = await import('puppeteer-core')
  const browser = await puppeteer.default.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const page = await browser.newPage()
    let videoUrl = null

    await page.setRequestInterception(true)
    page.on('request', req => {
      const u = req.url()
      if (!videoUrl && (u.includes('cdninstagram.com') || u.includes('fbcdn.net')) && u.includes('.mp4')) {
        videoUrl = u
      }
      req.continue()
    })
    page.on('response', async resp => {
      const u = resp.url()
      if (!videoUrl && (u.includes('cdninstagram.com') || u.includes('fbcdn.net')) && u.includes('.mp4')) {
        videoUrl = u
      }
    })

    await page.goto(url, { waitUntil: 'load', timeout: 60000 })
    try { await page.waitForSelector('video', { timeout: 15000 }) } catch {}

    if (!videoUrl) {
      videoUrl = await page.evaluate(() => {
        const v = document.querySelector('video[src]') || document.querySelector('video source[src]')
        return v ? v.src || v.getAttribute('src') : null
      })
    }

    if (!videoUrl) throw new Error('Nenhum vídeo encontrado nesta publicação do Threads.')
    return videoUrl
  } finally {
    await browser.close()
  }
}

// ─── Active downloads ─────────────────────────────────────────────────────────

const activeDownloads = new Map()

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 860,
    height: 660,
    minWidth: 640,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools()
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
app.on('before-quit', () => {
  for (const [, proc] of activeDownloads) proc.kill()
  activeDownloads.clear()
})

// ─── IPC: Settings ────────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => loadSettings())
ipcMain.handle('settings:set', (_, data) => { saveSettings(data); return true })

// ─── IPC: Dialog ──────────────────────────────────────────────────────────────

ipcMain.handle('dialog:choose-folder', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Escolher pasta de downloads',
  })
  return filePaths?.[0] || null
})

// ─── IPC: Download ────────────────────────────────────────────────────────────

// Formato: prioridade absoluta para áudio. Só cai em video-only como último recurso.
function buildFormatStr(maxQuality) {
  return [
    `bestvideo[height<=${maxQuality}][ext=mp4]+bestaudio[ext=m4a]`, // mp4 + m4a (ideal)
    `bestvideo[height<=${maxQuality}]+bestaudio`,                    // qualquer ext + áudio
    `best[height<=${maxQuality}][acodec!=none]`,                     // combined com áudio
    `best[acodec!=none]`,                                            // melhor com áudio (sem limite de altura)
    `best[height<=${maxQuality}]`,                                   // fallback sem garantia de áudio
    'best',                                                          // último recurso absoluto
  ].join('/')
}

// Tenta um download com o outputTemplate dado.
// Retorna: { status: 'done'|'conflict'|'cancelled'|'error', filePath?, title?, error? }
function attemptDownload({ id, downloadUrl, formatStr, outputTemplate, send }) {
  return new Promise((resolve) => {
    const args = [
      ...COOKIES_ARGS,
      '-f', formatStr,
      '--merge-output-format', 'mp4',
      '--newline',
      '--no-playlist',
      '-o', outputTemplate,
      downloadUrl,
    ]

    const proc = spawn(YT_DLP, args, { env: EXEC_ENV })
    activeDownloads.set(id, proc)

    let outFilePath = null
    let title = null
    let stderrBuf = ''
    let conflictKill = false // true quando matamos o proc por conflito de arquivo

    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        // Arquivo já existe → conflito, mata o proc e tenta próximo sufixo
        if (line.includes('has already been downloaded')) {
          conflictKill = true
          proc.kill('SIGTERM')
          return
        }

        // Destination → extrai título do nome do arquivo
        const dest = line.match(/\[download\] Destination:\s+(.+)/)
        if (dest) {
          outFilePath = dest[1].trim()
          const fname = outFilePath.replace(/\\/g, '/').split('/').pop()
          title = fname.replace(/\.[^.]+$/, '')
          send('download:progress', { id, percent: 0, title, speed: '', eta: '' })
        }

        // Progresso: [download]  45.3% of 123.45MiB at 2.50MiB/s ETA 00:20
        const prog = line.match(/\[download\]\s+([\d.]+)%\s+of\s+\S+\s+at\s+(\S+)\s+ETA\s+(\S+)/)
        if (prog) {
          send('download:progress', { id, percent: parseFloat(prog[1]), speed: prog[2], eta: prog[3], title })
        }

        // Merger → caminho final do arquivo mesclado
        const merge = line.match(/Merging formats into "(.+)"/)
        if (merge) outFilePath = merge[1].trim()
      }
    })

    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })

    proc.on('close', (code, signal) => {
      activeDownloads.delete(id)

      if (conflictKill) {
        resolve({ status: 'conflict' })
        return
      }

      // Morto por sinal externo (cancelamento do usuário)
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        resolve({ status: 'cancelled' })
        return
      }

      if (code === 0) {
        resolve({ status: 'done', filePath: outFilePath, title })
      } else {
        const lines = stderrBuf.trim().split('\n').filter(Boolean)
        const errMsg = lines.find(l => l.includes('ERROR:'))?.replace(/^.*ERROR:\s*/, '') || 'Erro no download.'
        resolve({ status: 'error', error: errMsg })
      }
    })

    proc.on('error', (err) => {
      activeDownloads.delete(id)
      resolve({ status: 'error', error: err.message })
    })
  })
}

ipcMain.handle('download:video', async (event, { id, url, maxQuality, folder }) => {
  const safeUrl = url.trim()
  let downloadUrl = safeUrl

  // Threads: extrai URL direta via Puppeteer
  if (isThreadsUrl(safeUrl)) {
    try {
      downloadUrl = await extractThreadsUrl(safeUrl)
    } catch (err) {
      try { event.sender.send('download:error', { id, error: err.message }) } catch {}
      return { success: false }
    }
  }

  const formatStr = buildFormatStr(maxQuality)
  const send = (channel, data) => { try { event.sender.send(channel, data) } catch {} }

  // Loop de auto-renomeação: tenta "Título.mp4", "Título (1).mp4", "Título (2).mp4"...
  for (let attempt = 0; attempt <= 99; attempt++) {
    const suffix = attempt === 0 ? '' : ` (${attempt})`
    const outputTemplate = join(folder, `%(title)s${suffix}.%(ext)s`)

    const result = await attemptDownload({ id, downloadUrl, formatStr, outputTemplate, send })

    if (result.status === 'conflict') continue  // arquivo existe → tenta próximo sufixo

    if (result.status === 'done') {
      send('download:done', { id, filePath: result.filePath, title: result.title })
      return { success: true }
    }

    if (result.status === 'cancelled') {
      send('download:error', { id, error: 'Cancelado.' })
      return { success: false }
    }

    // error
    send('download:error', { id, error: result.error })
    return { success: false }
  }

  send('download:error', { id, error: 'Não foi possível encontrar um nome disponível.' })
  return { success: false }
})

ipcMain.handle('download:cancel', (_, id) => {
  const proc = activeDownloads.get(id)
  if (proc) { proc.kill(); activeDownloads.delete(id) }
  return true
})

// ─── IPC: Shell ───────────────────────────────────────────────────────────────

ipcMain.handle('shell:open-external', (_, url) => shell.openExternal(url))
ipcMain.handle('shell:show-in-folder', (_, filePath) => shell.showItemInFolder(filePath))
