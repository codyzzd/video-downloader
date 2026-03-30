import { useState, useEffect, useRef } from 'react'

const QUALITY_OPTIONS = [
  { label: '4K — 2160p',      value: 2160 },
  { label: '1440p',            value: 1440 },
  { label: 'Full HD — 1080p', value: 1080 },
  { label: 'HD — 720p',       value: 720  },
  { label: '480p',             value: 480  },
  { label: '360p',             value: 360  },
]

let idSeq = 1

export default function App() {
  const [settings,  setSettings]  = useState({ folder: '', maxQuality: 1080 })
  const [urlInput,  setUrlInput]  = useState('')
  const [queue,     setQueue]     = useState([])
  const startingRef = useRef(new Set())

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    window.api.getSettings().then(s => setSettings(s))

    window.api.onDownloadProgress(({ id, percent, speed, eta, title }) => {
      setQueue(q => q.map(item =>
        item.id === id
          ? { ...item, percent, speed: speed || item.speed, eta: eta || item.eta, title: title || item.title }
          : item
      ))
    })

    window.api.onDownloadDone(({ id, filePath, title }) => {
      startingRef.current.delete(id)
      setQueue(q => q.map(item =>
        item.id === id
          ? { ...item, status: 'done', percent: 100, filePath, title: title || item.title }
          : item
      ))
    })

    window.api.onDownloadError(({ id, error }) => {
      startingRef.current.delete(id)
      setQueue(q => q.map(item =>
        item.id === id ? { ...item, status: 'error', error } : item
      ))
    })

    return () => window.api.offDownloadEvents()
  }, [])

  // ── Badge da Dock ─────────────────────────────────────────────────────────

  const prevActiveRef = useRef(0)

  useEffect(() => {
    const active = queue.filter(i => i.status === 'pending' || i.status === 'downloading').length
    const finished = queue.filter(i => i.status === 'done' || i.status === 'error').length

    window.api.setBadge(active)

    // Bounce quando todos terminam (transição de algum ativo → zero ativo)
    if (prevActiveRef.current > 0 && active === 0 && finished > 0) {
      window.api.bounceDock()
    }
    prevActiveRef.current = active
  }, [queue])

  // ── Queue processor (1 download at a time) ────────────────────────────────

  useEffect(() => {
    const downloading = queue.filter(i => i.status === 'downloading').length
    if (downloading >= 1) return

    const next = queue.find(i => i.status === 'pending' && !startingRef.current.has(i.id))
    if (!next) return

    startingRef.current.add(next.id)
    setQueue(q => q.map(i => i.id === next.id ? { ...i, status: 'downloading' } : i))

    window.api.downloadVideo({
      id: next.id,
      url: next.url,
      maxQuality: settings.maxQuality,
      folder: settings.folder,
    }).catch(() => { startingRef.current.delete(next.id) })
  }, [queue, settings])

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleChooseFolder() {
    const folder = await window.api.chooseFolder()
    if (folder) {
      const next = { ...settings, folder }
      setSettings(next)
      window.api.setSettings(next)
    }
  }

  function handleQualityChange(e) {
    const next = { ...settings, maxQuality: parseInt(e.target.value) }
    setSettings(next)
    window.api.setSettings(next)
  }

  function handleAddToQueue() {
    const urls = urlInput
      .split('\n')
      .map(u => u.trim())
      .filter(u => u.startsWith('http'))

    if (!urls.length || !settings.folder) return

    const newItems = urls.map(url => ({
      id: idSeq++,
      url,
      status: 'pending',
      percent: 0,
      speed: '',
      eta: '',
      title: null,
      filePath: null,
      error: null,
    }))

    setQueue(q => [...q, ...newItems])
    setUrlInput('')
  }

  async function handleCancelOrRemove(item) {
    if (item.status === 'downloading') {
      await window.api.cancelDownload(item.id)
      startingRef.current.delete(item.id)
    }
    setQueue(q => q.filter(i => i.id !== item.id))
  }

  function handleClearFinished() {
    setQueue(q => q.filter(i => i.status === 'pending' || i.status === 'downloading'))
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function domain(url) {
    try { return new URL(url).hostname.replace('www.', '') } catch { return url }
  }

  const hasDone = queue.some(i => i.status === 'done' || i.status === 'error')
  const stats = {
    pending:     queue.filter(i => i.status === 'pending').length,
    downloading: queue.filter(i => i.status === 'downloading').length,
    done:        queue.filter(i => i.status === 'done').length,
    error:       queue.filter(i => i.status === 'error').length,
  }
  const totalActive  = stats.pending + stats.downloading
  const totalDone    = stats.done + stats.error
  const showProgress = queue.length > 0

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app">

      {/* Titlebar */}
      <div className="titlebar">
        <div className="titlebar-traffic" />
        <span className="titlebar-title">Video <span>Downloader</span></span>
        <div className="titlebar-drag-hint">
          <span /><span /><span /><span /><span /><span />
        </div>
      </div>

      {/* Settings bar */}
      <div className="settings-bar">
        <button className="folder-btn" onClick={handleChooseFolder} title="Escolher pasta">
          <span className="folder-icon">📁</span>
          <span className="folder-path">{settings.folder || 'Escolher pasta de destino…'}</span>
        </button>
        <select
          className="quality-select"
          value={settings.maxQuality}
          onChange={handleQualityChange}
          title="Qualidade máxima"
        >
          {QUALITY_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* URL Input */}
      <div className="input-section">
        <textarea
          className="url-textarea"
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAddToQueue() }}
          placeholder={'Cole uma ou mais URLs aqui (uma por linha)\nhttps://youtube.com/watch?v=...\nhttps://instagram.com/reel/...'}
          rows={3}
        />
        <div className="input-actions">
          <button
            className="btn-add"
            onClick={handleAddToQueue}
            disabled={!urlInput.trim() || !settings.folder}
          >
            ⬇ Adicionar à fila
          </button>
          {!settings.folder && (
            <span className="hint-inline">← Escolha uma pasta primeiro</span>
          )}
          {hasDone && (
            <button className="btn-clear" onClick={handleClearFinished}>
              Limpar concluídos
            </button>
          )}
        </div>
      </div>

      {/* Queue */}
      <div className="queue-section">
        {queue.length > 0 ? (
          <>
            <div className="queue-header">
              <span className="queue-label">Fila</span>

              {showProgress && (
                <div className="queue-progress-summary">
                  {totalActive > 0 ? (
                    <>
                      <span className="qps-fraction">
                        {totalDone} <span className="qps-sep">de</span> {queue.length}
                      </span>
                      <div className="qps-bar">
                        <div
                          className="qps-bar-fill"
                          style={{ width: `${(totalDone / queue.length) * 100}%` }}
                        />
                      </div>
                      <span className="qps-label">baixados</span>
                    </>
                  ) : (
                    <span className="qps-done">✓ Todos concluídos</span>
                  )}
                </div>
              )}

              <div className="queue-stats">
                {stats.downloading > 0 && <span className="stat stat-active">⬇ {stats.downloading}</span>}
                {stats.pending > 0     && <span className="stat stat-pending">⏳ {stats.pending}</span>}
                {stats.done > 0        && <span className="stat stat-done">✓ {stats.done}</span>}
                {stats.error > 0       && <span className="stat stat-error">✕ {stats.error}</span>}
              </div>
            </div>
            <div className="queue-list">
              {queue.map(item => (
                <QueueItem
                  key={item.id}
                  item={item}
                  displayName={item.title || domain(item.url)}
                  onCancel={() => handleCancelOrRemove(item)}
                  onShow={() => window.api.showInFolder(item.filePath)}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">⬇</div>
            <p className="empty-title">Nenhum download na fila</p>
            <p className="empty-sub">Cole URLs acima para começar</p>
          </div>
        )}
      </div>

    </div>
  )
}

// ─── Queue Item ───────────────────────────────────────────────────────────────

function QueueItem({ item, displayName, onCancel, onShow }) {
  const META = {
    pending:     { icon: '⏳', cls: 'qi-pending'     },
    downloading: { icon: '⬇',  cls: 'qi-downloading' },
    done:        { icon: '✓',  cls: 'qi-done'        },
    error:       { icon: '✕',  cls: 'qi-error'       },
  }
  const m = META[item.status] || META.pending

  return (
    <div className={`queue-item ${m.cls}`}>
      <div className="qi-row">
        <span className="qi-status-icon">{m.icon}</span>

        <div className="qi-body">
          <div className="qi-name">{displayName}</div>
          <div className="qi-sub">
            {item.status === 'downloading' && item.speed && (
              <span>{item.speed} · ETA {item.eta}</span>
            )}
            {item.status === 'downloading' && !item.speed && (
              <span>Iniciando…</span>
            )}
            {item.status === 'pending' && (
              <span>Aguardando na fila</span>
            )}
            {item.status === 'done' && item.filePath && (
              <span className="qi-filepath">{item.filePath.replace(/\\/g, '/').split('/').pop()}</span>
            )}
            {item.status === 'error' && (
              <span className="qi-errmsg">{item.error}</span>
            )}
          </div>
        </div>

        <div className="qi-btns">
          {item.status === 'done' && (
            <button className="qi-btn qi-btn-open" onClick={onShow} title="Mostrar no Finder">
              ↗
            </button>
          )}
          {item.status !== 'done' && (
            <button
              className="qi-btn qi-btn-remove"
              onClick={onCancel}
              title={item.status === 'downloading' ? 'Cancelar' : 'Remover'}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {(item.status === 'downloading' || item.status === 'done') && (
        <div className="qi-progress-track">
          <div className="qi-progress-fill" style={{ width: `${item.percent}%` }} />
        </div>
      )}
    </div>
  )
}
