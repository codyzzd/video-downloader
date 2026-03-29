import { useState } from 'react'

function fmtSize(bytes) {
  if (!bytes) return ''
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB'
  return (bytes / 1e3).toFixed(0) + ' KB'
}

export default function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [linkLoading, setLinkLoading] = useState(false)
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)

  async function analyze() {
    if (!url.trim()) return
    setError('')
    setResult(null)
    setLink('')
    setLoading(true)
    try {
      const data = await window.api.getInfo(url.trim())
      setResult(data)
    } catch (e) {
      setError(e.message || 'Erro ao analisar o vídeo.')
    } finally {
      setLoading(false)
    }
  }

  async function selectFormat(formatId, directLink) {
    setError('')
    setLink('')
    if (directLink) {
      setLink(directLink)
      return
    }
    setLinkLoading(true)
    try {
      const data = await window.api.getLink(url.trim(), formatId)
      setLink(data.link)
    } catch (e) {
      setError(e.message || 'Erro ao obter link de download.')
    } finally {
      setLinkLoading(false)
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="app">
      <header>
        <h1>Video <span>Downloader</span></h1>
        <p>YouTube · Instagram · TikTok · Facebook · LinkedIn · Threads · X</p>
      </header>

      <div className="card">
        <div className="input-row">
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && analyze()}
            placeholder="Cole a URL do vídeo aqui..."
            disabled={loading}
            autoComplete="off"
          />
          <button className="primary" onClick={analyze} disabled={loading || !url.trim()}>
            Analisar
          </button>
        </div>

        {loading && (
          <div className="spinner-wrap">
            <div className="spinner" />
            <span>Analisando vídeo...</span>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        {result && (
          <div className="result">
            <div className="video-info">
              {result.thumbnail && (
                <img
                  src={result.thumbnail}
                  alt="thumbnail"
                  onError={e => { e.currentTarget.style.display = 'none' }}
                />
              )}
              <div className="meta">
                <h2>{result.title}</h2>
                <p>{result.formats.length} formato(s) disponível(is)</p>
              </div>
            </div>

            <FormatGroups formats={result.formats} onSelect={selectFormat} />

            {linkLoading && (
              <div className="toast">
                <div className="toast-spinner" />
                <span>Obtendo link de download...</span>
              </div>
            )}

            {link && (
              <div className="link-panel">
                <div className="link-panel-title">Link obtido</div>
                <div className="link-panel-actions">
                  <button
                    className="btn-action btn-download"
                    onClick={() => window.api.downloadStart(link)}
                  >
                    ⬇ Baixar
                  </button>
                  <button
                    className="btn-action btn-open"
                    onClick={() => window.api.openExternal(link)}
                  >
                    ↗ Abrir no navegador
                  </button>
                </div>
                <div className="link-row">
                  <div className="link-text">{link}</div>
                  <button
                    className={`btn-copy${copied ? ' copied' : ''}`}
                    onClick={copyLink}
                  >
                    {copied ? 'Copiado!' : 'Copiar'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <footer>O download ocorre direto da plataforma para o seu dispositivo.</footer>
    </div>
  )
}

function FormatGroups({ formats, onSelect }) {
  const withAudio    = formats.filter(f => f.audioStatus === 'yes')
  const unknownAudio = formats.filter(f => f.audioStatus === 'unknown')
  const noAudio      = formats.filter(f => f.audioStatus === 'no')

  return (
    <div>
      <div className="formats-label">Qualidades disponíveis</div>
      <FormatSection formats={withAudio}    label="🔊 Com áudio"                       labelClass="has-audio"     onSelect={onSelect} />
      <FormatSection formats={unknownAudio} label="❓ Áudio incerto — pode ter ou não" labelClass="unknown-audio" onSelect={onSelect} />
      <FormatSection formats={noAudio}      label="🔇 Sem áudio (somente vídeo)"       labelClass="no-audio"      onSelect={onSelect} />
    </div>
  )
}

function FormatSection({ formats, label, labelClass, onSelect }) {
  if (formats.length === 0) return null
  return (
    <div className="formats-section">
      <div className={`formats-section-label ${labelClass}`}>{label}</div>
      <div className="formats-grid">
        {formats.map(f => (
          <button
            key={f.format_id}
            className="fmt-btn"
            onClick={() => onSelect(f.format_id, f.directLink)}
          >
            <span className="res">{f.height ? f.height + 'p' : (f.label || 'Original')}</span>
            <span className="ext">{f.ext}</span>
            {f.filesize && <span className="size">{fmtSize(f.filesize)}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
