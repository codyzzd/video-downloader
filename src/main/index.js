import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Quando empacotado, usa o binário bundlado em Resources/bin/yt-dlp.
// Em dev, cai no yt-dlp do sistema (precisa estar no PATH).
const YT_DLP = app.isPackaged
  ? join(process.resourcesPath, 'bin', 'yt-dlp')
  : 'yt-dlp'

// Apps empacotados no macOS não herdam o PATH do terminal.
// Inclui os diretórios mais comuns como fallback (para o modo dev).
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

// Detecta o Chrome instalado no sistema (macOS e Windows)
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

  const { existsSync } = require('fs')
  return candidates.find(p => existsSync(p)) || null
}

function isThreadsUrl(url) {
  return /threads\.(com|net)/i.test(url)
}

async function extractThreads(url) {
  const chromePath = findChrome()
  if (!chromePath) {
    throw new Error(
      'Para baixar vídeos do Threads é necessário ter o Google Chrome instalado.\n' +
      'Baixe em: https://www.google.com/chrome'
    )
  }

  const puppeteer = await import('puppeteer-core')

  const browser = await puppeteer.default.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const page = await browser.newPage()

    let videoUrl = null
    let thumbnail = null
    let title = 'Threads'

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

    try {
      await page.waitForSelector('video', { timeout: 15000 })
    } catch (_) { /* sem video no DOM */ }

    if (!videoUrl) {
      videoUrl = await page.evaluate(() => {
        const v = document.querySelector('video[src]') || document.querySelector('video source[src]')
        return v ? v.src || v.getAttribute('src') : null
      })
    }

    const finalUrl = page.url()
    if (!videoUrl && (finalUrl.includes('/login') || finalUrl.includes('/accounts/login'))) {
      throw new Error('O Threads redirecionou para login. Esta publicação pode ser privada ou requer autenticação.')
    }

    title = await page.evaluate(() => {
      const m = document.querySelector('meta[property="og:title"]') ||
                document.querySelector('meta[name="title"]')
      return m ? m.content : document.title || 'Threads'
    })

    thumbnail = await page.evaluate(() => {
      const m = document.querySelector('meta[property="og:image"]')
      return m ? m.content : null
    })

    if (!videoUrl) throw new Error('Nenhum vídeo encontrado nesta publicação do Threads.')

    return {
      title,
      thumbnail,
      formats: [{
        format_id: 'threads_direct',
        height: null,
        ext: 'mp4',
        filesize: null,
        tbr: null,
        audioStatus: 'yes',
        hasAudio: true,
        hasVideo: true,
        directLink: videoUrl,
        label: 'Original',
      }],
    }
  } finally {
    await browser.close()
  }
}

// ─── Janela principal ────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // Em dev o electron-vite injeta ELECTRON_RENDERER_URL
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools()
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ─── IPC: api:get-info ────────────────────────────────────────────────────────

ipcMain.handle('api:get-info', async (_, url) => {
  const safeUrl = url.trim()

  if (isThreadsUrl(safeUrl)) {
    return await extractThreads(safeUrl)
  }

  let stdout, stderr
  try {
    ;({ stdout, stderr } = await execAsync(`"${YT_DLP}" --dump-json "${safeUrl}"`, { maxBuffer: 10 * 1024 * 1024, env: EXEC_ENV }))
  } catch (err) {
    const raw = (err.stderr || err.message || '').trim()
    let msg = raw
    if (raw.includes('Unsupported URL') || raw.includes('generic information extractor')) {
      msg = 'URL não suportada. Plataformas aceitas: YouTube, Instagram, Facebook, LinkedIn, X e Threads.'
    } else if (raw.includes('Video unavailable')) {
      msg = 'Vídeo indisponível ou privado.'
    } else if (raw.includes('Sign in') || raw.includes('login')) {
      msg = 'Este vídeo requer login. Tente uma URL pública.'
    }
    throw new Error(msg)
  }

  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new Error('Não foi possível parsear a resposta do yt-dlp.')
  }

  const title = data.title || 'Sem título'
  const thumbnail = data.thumbnail || null
  const rawFormats = data.formats || []

  const rootHeight = data.height || null

  const seen = new Set()
  const formats = rawFormats
    .filter(f => {
      const height = f.height || rootHeight
      const ext = f.ext || f.video_ext
      return ext && ['mp4', 'webm', 'mkv', 'mov'].includes(ext)
    })
    .map(f => {
      f = { ...f, height: f.height || rootHeight, ext: f.ext || f.video_ext }

      const hasAudioChannels = f.audio_channels && f.audio_channels > 0
      const hasAbr = f.abr && f.abr > 0
      const acodecDeclared = f.acodec && f.acodec !== 'none'
      const acodecAbsent = !f.acodec || f.acodec === 'none'

      let audioStatus
      if (hasAudioChannels || hasAbr || acodecDeclared) {
        audioStatus = 'yes'
      } else if (acodecAbsent && (hasAudioChannels === false || f.audio_channels === 0)) {
        audioStatus = 'no'
      } else if (acodecAbsent && !hasAudioChannels && !hasAbr) {
        audioStatus = 'unknown'
      } else {
        audioStatus = 'no'
      }

      const hasVideo = f.vcodec && f.vcodec !== 'none'
      return {
        format_id: f.format_id,
        height: f.height,
        ext: f.ext,
        filesize: f.filesize || f.filesize_approx || null,
        tbr: f.tbr || null,
        audioStatus,
        hasAudio: audioStatus === 'yes',
        hasVideo,
      }
    })
    .filter(f => {
      const key = `${f.height}-${f.ext}-${f.audioStatus}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => {
      if (b.height !== a.height) return b.height - a.height
      const order = { yes: 2, unknown: 1, no: 0 }
      return (order[b.audioStatus] || 0) - (order[a.audioStatus] || 0)
    })

  if (formats.length === 0) {
    throw new Error('Nenhum formato de vídeo disponível para esta URL.')
  }

  return { title, thumbnail, formats }
})

// ─── IPC: api:get-link ────────────────────────────────────────────────────────

ipcMain.handle('api:get-link', async (_, url, formatId) => {
  const safeUrl = url.trim()

  if (isThreadsUrl(safeUrl) && formatId === 'threads_direct') {
    const data = await extractThreads(safeUrl)
    return { link: data.formats[0].directLink }
  }

  const safeFormatId = String(formatId).replace(/[^a-zA-Z0-9_+\-]/g, '')

  let stdout
  try {
    ;({ stdout } = await execAsync(`"${YT_DLP}" --get-url -f "${safeFormatId}" "${safeUrl}"`, { env: EXEC_ENV }))
  } catch (err) {
    throw new Error((err.stderr || err.message || 'Erro ao obter link de download.').trim())
  }

  const link = stdout.trim()
  if (!link) throw new Error('Link direto não encontrado para este formato.')

  return { link }
})

// ─── IPC: utilitários ─────────────────────────────────────────────────────────

ipcMain.handle('shell:open-external', (_, url) => {
  shell.openExternal(url)
})

ipcMain.handle('download:start', (event, url) => {
  event.sender.downloadURL(url)
})
