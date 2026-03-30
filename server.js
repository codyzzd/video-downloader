const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cookiesFlag = process.platform === 'darwin' ? '--cookies-from-browser "chrome:Default"' : '';

// Extrator para Threads usando Puppeteer (intercepta requisições de rede para encontrar o vídeo)
async function extractThreads(url) {
  const puppeteer = require('puppeteer-core');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();

    // Intercepta requisições para capturar URLs de vídeo do CDN
    let videoUrl = null;
    let thumbnail = null;
    let title = 'Threads';

    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (!videoUrl && (u.includes('cdninstagram.com') || u.includes('fbcdn.net')) && u.includes('.mp4')) {
        videoUrl = u;
      }
      req.continue();
    });

    // Também captura respostas (às vezes o src do <video> é preenchido após fetch)
    page.on('response', async resp => {
      const u = resp.url();
      if (!videoUrl && (u.includes('cdninstagram.com') || u.includes('fbcdn.net')) && u.includes('.mp4')) {
        videoUrl = u;
      }
    });

    await page.goto(url, { waitUntil: 'load', timeout: 60000 });

    // Espera até 15s pelo elemento <video> aparecer no DOM
    try {
      await page.waitForSelector('video', { timeout: 15000 });
    } catch (_) { /* sem video no DOM, tenta outros métodos */ }

    // Tenta pegar o src do <video>
    if (!videoUrl) {
      videoUrl = await page.evaluate(() => {
        const v = document.querySelector('video[src]') || document.querySelector('video source[src]');
        return v ? v.src || v.getAttribute('src') : null;
      });
    }

    // Última tentativa: checar a URL atual (pode ter redirecionado para login)
    const finalUrl = page.url();
    if (!videoUrl && (finalUrl.includes('/login') || finalUrl.includes('/accounts/login'))) {
      throw new Error('O Threads redirecionou para login. Esta publicação pode ser privada ou requer autenticação.');
    }

    // Extrai título e thumbnail das metatags (agora que o JS renderizou)
    title = await page.evaluate(() => {
      const m = document.querySelector('meta[property="og:title"]') ||
                document.querySelector('meta[name="title"]');
      return m ? m.content : document.title || 'Threads';
    });

    thumbnail = await page.evaluate(() => {
      const m = document.querySelector('meta[property="og:image"]');
      return m ? m.content : null;
    });

    if (!videoUrl) throw new Error('Nenhum vídeo encontrado nesta publicação do Threads.');

    return {
      title,
      thumbnail,
      formats: [{
        format_id: 'threads_direct',
        height: null,
        ext: 'mp4',
        filesize: null,
        tbr: null,
        hasAudio: true,
        hasVideo: true,
        directLink: videoUrl,
        label: 'Original',
      }],
    };
  } finally {
    await browser.close();
  }
}

function isThreadsUrl(url) {
  return /threads\.(com|net)/i.test(url);
}

// POST /api/info — extrai formatos disponíveis de uma URL
app.post('/api/info', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL não informada.' });
  }

  const safeUrl = url.trim();

  // Threads: usa extrator nativo
  if (isThreadsUrl(safeUrl)) {
    try {
      const data = await extractThreads(safeUrl);
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Demais plataformas: usa yt-dlp
  exec(`yt-dlp ${cookiesFlag} --dump-json "${safeUrl}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const raw = (stderr || err.message || '').trim();
      let msg = raw;
      if (raw.includes('Unsupported URL') || raw.includes('generic information extractor')) {
        msg = 'URL não suportada. Plataformas aceitas: YouTube, Instagram, Facebook, LinkedIn, X e Threads.';
      } else if (raw.includes('Video unavailable')) {
        msg = 'Vídeo indisponível ou privado.';
      } else if (raw.includes('Sign in') || raw.includes('login')) {
        msg = 'Este vídeo requer login. Tente uma URL pública.';
      }
      return res.status(500).json({ error: msg });
    }

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      return res.status(500).json({ error: 'Não foi possível parsear a resposta do yt-dlp.' });
    }

    const title = data.title || 'Sem título';
    const thumbnail = data.thumbnail || null;
    const rawFormats = data.formats || [];

    // Fallbacks do nível raiz (LinkedIn, generic extractor)
    const rootHeight    = data.height    || null;
    const rootWidth     = data.width     || null;
    const rootThumbnail = data.thumbnail || null;

    const seen = new Set();
    const formats = rawFormats
      .filter(f => {
        const height = f.height || rootHeight;
        const ext    = f.ext || f.video_ext;
        return ext && ['mp4', 'webm', 'mkv', 'mov'].includes(ext);
      })
      .map(f => {
        // herda height/ext do nível raiz quando o formato não traz
        f = { ...f, height: f.height || rootHeight, ext: f.ext || f.video_ext };
        // Detecção de áudio em 3 camadas de confiança:
        // 1. audio_channels > 0  → tem áudio (sinal mais confiável)
        // 2. abr > 0             → tem áudio (bitrate de áudio presente)
        // 3. acodec !== 'none'   → tem áudio (declarado pelo extrator)
        // Se acodec = 'none' mas audio_channels/abr não estão presentes → incerto
        const hasAudioChannels = f.audio_channels && f.audio_channels > 0;
        const hasAbr = f.abr && f.abr > 0;
        const acodecDeclared = f.acodec && f.acodec !== 'none';
        const acodecAbsent = !f.acodec || f.acodec === 'none';

        let audioStatus; // 'yes' | 'no' | 'unknown'
        if (hasAudioChannels || hasAbr || acodecDeclared) {
          audioStatus = 'yes';
        } else if (acodecAbsent && (hasAudioChannels === false || f.audio_channels === 0)) {
          // audio_channels explicitamente 0 = sem áudio de verdade
          audioStatus = 'no';
        } else if (acodecAbsent && !hasAudioChannels && !hasAbr) {
          // acodec diz 'none' mas não temos confirmação de outros campos
          audioStatus = 'unknown';
        } else {
          audioStatus = 'no';
        }

        const hasVideo = f.vcodec && f.vcodec !== 'none';
        return {
          format_id: f.format_id,
          height: f.height,
          ext: f.ext,
          filesize: f.filesize || f.filesize_approx || null,
          tbr: f.tbr || null,
          audioStatus, // 'yes' | 'no' | 'unknown'
          hasAudio: audioStatus === 'yes',
          hasVideo,
        };
      })
      .filter(f => {
        const key = `${f.height}-${f.ext}-${f.audioStatus}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        if (b.height !== a.height) return b.height - a.height;
        // ordem: yes > unknown > no
        const order = { yes: 2, unknown: 1, no: 0 };
        return (order[b.audioStatus] || 0) - (order[a.audioStatus] || 0);
      });

    if (formats.length === 0) {
      return res.status(404).json({ error: 'Nenhum formato de vídeo disponível para esta URL.' });
    }

    res.json({ title, thumbnail, formats });
  });
});

// POST /api/get-link — retorna o link direto de download para um formato
app.post('/api/get-link', async (req, res) => {
  const { url, format_id } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL não informada.' });
  }
  if (!format_id) {
    return res.status(400).json({ error: 'format_id não informado.' });
  }

  const safeUrl = url.trim();

  // Threads: o link direto já foi extraído no /api/info e salvo em directLink
  if (isThreadsUrl(safeUrl) && format_id === 'threads_direct') {
    try {
      const data = await extractThreads(safeUrl);
      const fmt = data.formats[0];
      return res.json({ link: fmt.directLink });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const safeFormatId = String(format_id).replace(/[^a-zA-Z0-9_+\-]/g, '');

  exec(`yt-dlp ${cookiesFlag} --get-url -f "${safeFormatId}" "${safeUrl}"`, (err, stdout, stderr) => {
    if (err) {
      const msg = stderr || err.message || 'Erro ao obter link de download.';
      return res.status(500).json({ error: msg.trim() });
    }

    const link = stdout.trim();
    if (!link) {
      return res.status(404).json({ error: 'Link direto não encontrado para este formato.' });
    }

    res.json({ link });
  });
});

app.listen(PORT, () => {
  console.log(`✓ video-downloader rodando em http://localhost:${PORT}`);
});
