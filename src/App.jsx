import { useState, useRef, useEffect } from 'react'

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d } catch { return d } }
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
const uid  = () => Math.random().toString(36).slice(2, 10)
const esc  = t => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

const API = 'http://localhost:8000'
const KS  = 'ragbot.settings'
const KC  = 'ragbot.currentChat'
const DEF = { url: `${API}/chat`, msg: 'message', auth: '', name: 'Nexus AI' }


// Lightweight syntax highlighter
function highlight(code, lang) {
  if (!lang) return code
  const l = lang.toLowerCase()
  const cmt = /^(py|rb|sh|ba|zs|ya)/.test(l) ? '#[^\\n]*'
            : /^(sq)/.test(l) ? '--[^\\n]*'
            : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'
  const kw = [
    'def','class','if','elif','else','for','while','return','import','from','as',
    'try','except','finally','with','yield','lambda','pass','break','continue',
    'and','or','not','in','is','raise','True','False','None','self','del',
    'global','nonlocal','assert','async','await',
    'const','let','var','function','new','this','catch','throw',
    'typeof','instanceof','true','false','null','undefined','switch','case',
    'default','do','of','super','extends','export','void','static','delete',
    'public','private','protected','int','float','double','boolean','char',
    'string','struct','enum','interface','fn','pub','mut','impl','trait',
    'match','loop','main','func','type','package','go','defer','chan',
    'SELECT','FROM','WHERE','INSERT','UPDATE','DELETE','CREATE','TABLE',
    'JOIN','AND','OR','NOT','NULL','ORDER','BY','GROUP','HAVING','LIMIT',
    'VALUES','SET','INTO','DROP','ALTER','DISTINCT','AS','ON','BETWEEN',
  ].join('|')
  const re = new RegExp(
    `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')|(${cmt})|(\\b(?:${kw})\\b)|(\\b\\d+\\.?\\d*\\b)|(\\b[a-zA-Z_]\\w*(?=\\s*\\())`,
    'gm'
  )
  return code.replace(re, (m, s, c, k, n, f) => {
    if (s) return `<span class="hl-s">${m}</span>`
    if (c) return `<span class="hl-c">${m}</span>`
    if (k) return `<span class="hl-k">${m}</span>`
    if (n) return `<span class="hl-n">${m}</span>`
    if (f) return `<span class="hl-f">${m}</span>`
    return m
  })
}

// Tiny markdown renderer
function md(t) {
  const blocks = []
  t = esc(t).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, l, c) => {
    blocks.push({ lang: l, code: c.replace(/\n$/, '') })
    return `\u0000${blocks.length - 1}\u0000`
  })
  const inl = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  const boldLead = s => s.replace(/^([^<:]{2,60}:)/, '<b>$1</b>')
  const out = []; let list = null
  const close = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const ln of t.split('\n')) {
    let m
    if ((m = ln.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul' } out.push('<li>' + boldLead(inl(m[1])) + '</li>') }
    else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol' } out.push('<li>' + boldLead(inl(m[1])) + '</li>') }
    else if ((m = ln.match(/^#{1,6}\s+(.*)/))) { close(); out.push('<p><b>' + inl(m[1]) + '</b></p>') }
    else if (!ln.trim()) { /* skip blank lines — don't break lists */ }
    else { close(); out.push('<p>' + inl(ln) + '</p>') }
  }
  close()
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const b = blocks[i]
    return `<pre${b.lang ? ` data-lang="${b.lang}"` : ''}><button class="cp">Copy</button><code>${highlight(b.code, b.lang)}</code></pre>`
  })
}

function pick(o) {
  if (o == null) return ''
  if (typeof o === 'string') return o
  if (o.choices?.[0]) return o.choices[0].delta?.content ?? o.choices[0].message?.content ?? ''
  for (const k of ['reply', 'response', 'answer', 'text', 'content', 'message', 'output', 'result']) {
    if (o[k] != null) { const r = pick(o[k]); if (r) return r }
  }
  return ''
}

const SUGGESTIONS = [
  { icon: '🚀', title: 'Explain a complex topic', desc: 'in simple, clear terms' },
  { icon: '💻', title: 'Write or review code',   desc: 'any language, any task' },
  { icon: '📝', title: 'Draft content for me',   desc: 'emails, essays, ideas' },
  { icon: '🔍', title: 'Analyze & summarize',    desc: 'research, docs, data' },
]

// AI icon SVG
const BotIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="10" rx="2"/>
    <path d="M12 11V7"/>
    <circle cx="12" cy="5" r="2"/>
    <path d="M8 15h.01M12 15h.01M16 15h.01"/>
  </svg>
)

function Message({ m, onRetry }) {
  const [copied, setCopied] = useState(false)

  if (m.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-bubble">{m.content}</div>
      </div>
    )
  }

  return (
    <div className="msg msg-ai">
      <div className="ai-avatar"><BotIcon size={17} /></div>
      <div className="msg-bubble">
        {m.error
          ? <div className="err">⚠ {m.content}</div>
          : <div dangerouslySetInnerHTML={{ __html: md(m.content) }} />
        }
        {!m.error && !m.live && (
          <div className="acts">
            <button title="Copy response" onClick={() => { navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
              {copied
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              }
            </button>
            <button title="Retry" onClick={onRetry}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const [S, setS]         = useState({ ...DEF, ...load(KS, {}) })
  const [chats, setChats] = useState([])          // { id, title, msgs, msg_count } — sourced from SQLite backend
  const [cur, setCurRaw]  = useState(() => load(KC, null))
  const [input, setInput] = useState('')
  const [busy, setBusy]   = useState(false)
  const [live, setLive]   = useState(null)
  const [sideOpen, setSideOpen] = useState(true)
  const [draft, setDraft] = useState(S)
  const [loadingThread, setLoadingThread] = useState(false)

  const ctl       = useRef(null)
  const ta        = useRef(null)
  const dlg       = useRef(null)
  const scrollRef = useRef(null)

  // Wrap setCur to persist the active conversation ID
  const setCur = (id) => { setCurRaw(id); save(KC, id) }

  const active    = chats.find(c => c.id === cur)
  const msgs      = active?.msgs || []
  const isWelcome = !msgs.length && live === null

  // ── Fetch thread list from backend ─────────────────────────────
  async function fetchThreads() {
    try {
      const r = await fetch(`${API}/conversations`)
      if (!r.ok) return
      const { threads } = await r.json()
      if (!Array.isArray(threads)) return
      // threads is now [{id, title, msg_count}, ...]
      setChats(cs => {
        const existing = new Map(cs.map(c => [c.id, c]))
        return threads.map(t => {
          const cached = existing.get(t.id)
          // Keep cached msgs if already loaded, but always update the title & msg_count from DB
          return cached
            ? { ...cached, title: t.title, msg_count: t.msg_count }
            : { id: t.id, title: t.title, msgs: [], msg_count: t.msg_count || 0 }
        })
      })
    } catch {}
  }

  // ── Load messages for a thread from backend ────────────────────
  async function loadThread(id) {
    if (!id) return
    // Skip only if already loaded with messages in this session
    const existing = chats.find(c => c.id === id)
    if (existing?.msgs?.length) return
    setLoadingThread(true)
    try {
      const r = await fetch(`${API}/conversations/${id}`)
      if (!r.ok) { setLoadingThread(false); return }
      const { messages } = await r.json()
      if (!messages?.length) { setLoadingThread(false); return }
      const title = messages.find(m => m.role === 'user')?.content?.slice(0, 50) || id
      setChats(cs => cs.map(c => c.id === id ? { ...c, msgs: messages, title } : c))
    } catch {}
    finally { setLoadingThread(false) }
  }

  // On mount — load thread list from SQLite backend
  useEffect(() => { fetchThreads() }, [])

  // When switching thread — load messages if not yet in memory
  useEffect(() => { if (cur) loadThread(cur) }, [cur])

  useEffect(() => {
    const s = scrollRef.current
    if (s) s.scrollTop = s.scrollHeight
  }, [chats, live, cur])

  function fit() {
    const t = ta.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 200) + 'px'
  }

  async function send(text, base) {
    if (busy || !text.trim()) return
    const optimisticMsgs = base ?? [...(active?.msgs || []), { role: 'user', content: text }]
    let id = cur
    if (!id) { id = uid(); setCur(id) }

    // Optimistically update UI with user message
    setChats(cs => cs.some(c => c.id === id)
      ? cs.map(c => c.id === id ? {
          ...c,
          msgs: optimisticMsgs,
          title: (c.title === 'New Conversation' && optimisticMsgs.filter(m => m.role === 'user').length === 1)
            ? text.slice(0, 42) : c.title
        } : c)
      : [{ id, title: text.slice(0, 42), msgs: optimisticMsgs }, ...chats])

    // POST only the new message — SqliteSaver restores history by thread_id
    const payload = { message: text, conversation_id: id }

    let reply = ''
    setBusy(true); setLive('')
    ctl.current = new AbortController()
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (S.auth) headers.Authorization = S.auth
      const r = await fetch(S.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctl.current.signal })
      if (!r.ok) throw new Error(`Backend returned ${r.status} ${r.statusText}. ${(await r.text()).slice(0, 200)}`)
      const ct = r.headers.get('content-type') || ''
      if (ct.includes('application/json')) {
        reply = pick(await r.json()) || '(empty reply)'
      } else {
        const rd = r.body.getReader(), dec = new TextDecoder()
        const sse = ct.includes('event-stream'); let buf = ''
        while (true) {
          const { done, value } = await rd.read(); if (done) break
          const chunk = dec.decode(value, { stream: true })
          if (sse) {
            buf += chunk; const parts = buf.split('\n'); buf = parts.pop()
            for (const p of parts) {
              if (!p.startsWith('data:')) continue
              const d = p.slice(5).replace(/^ /, '')
              if (d.trim() === '[DONE]') continue
              try { reply += pick(JSON.parse(d)) } catch { reply += d }
            }
          } else reply += chunk
          setLive(reply)
        }
        if (!reply) reply = '(empty reply)'
      }
      setChats(cs => cs.map(c => c.id === id
        ? { ...c, msgs: [...optimisticMsgs, { role: 'assistant', content: reply }] }
        : c))
    } catch (e) {
      if (e.name === 'AbortError') {
        if (reply) setChats(cs => cs.map(c => c.id === id
          ? { ...c, msgs: [...optimisticMsgs, { role: 'assistant', content: reply }] }
          : c))
      } else {
        const content = e instanceof TypeError
          ? `Can't reach ${S.url}. Make sure the backend is running and CORS is enabled.`
          : e.message
        setChats(cs => cs.map(c => c.id === id
          ? { ...c, msgs: [...optimisticMsgs, { role: 'assistant', error: true, content }] }
          : c))
      }
    }
    setLive(null); setBusy(false)
  }


  function submit() {
    if (busy) { ctl.current?.abort(); return }
    const t = input; setInput(''); requestAnimationFrame(fit); send(t)
  }

  function retry(i) { const base = active.msgs.slice(0, i); send(base[i - 1].content, base) }

  function onMsgClick(e) {
    if (e.target.classList.contains('cp')) {
      navigator.clipboard.writeText(e.target.nextElementSibling.textContent)
      e.target.textContent = '✓'; setTimeout(() => (e.target.textContent = 'Copy'), 1200)
    }
  }

  const newChat = () => {
    const newId = uid()
    setCur(newId)
    setChats(cs => cs.some(c => c.id === newId) ? cs : [{ id: newId, title: 'New Conversation', msgs: [] }, ...cs])
    setInput('')
    ta.current?.focus()
  }

  // Delete a thread — also removes it from SQLite via the backend
  async function deleteThread(id) {
    setChats(cs => cs.filter(x => x.id !== id))
    if (cur === id) setCur(null)
    try { await fetch(`${API}/conversations/${id}`, { method: 'DELETE' }) } catch {}
  }

  // ComposerBar inlined below to avoid remount-on-render cursor loss

  return (
    <>
      {sideOpen && <div className="overlay mobile-only" onClick={() => setSideOpen(false)} />}

      {/* ── Sidebar ── */}
      <aside className={sideOpen ? '' : 'collapsed'}>
        {/* Sidebar Header */}
        <div className="side-header">
          <div className="side-header-top">
            <div className="side-brand-mark">
              <BotIcon size={15} />
            </div>
            <span className="side-app-title">{S.name}</span>
            <button className="side-toggle" onClick={() => setSideOpen(o => !o)} title="Toggle sidebar">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
            </button>
          </div>
          <button className="start-chat-btn" onClick={newChat}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
            Start Chat
          </button>
        </div>

        {/* My Conversations */}
        <div className="chat-list">
          <div className="chat-section-label">My Conversations</div>
          {chats.length === 0 && (
            <div className="no-chats-hint">No conversations yet.<br/>Click <b>Start Chat</b> to begin.</div>
          )}
          {chats
            .filter(c => c.msgs.length > 0 || (c.msg_count || 0) > 0 || c.id === cur)
            .map(c => (
            <button key={c.id} className={'chat-item' + (c.id === cur ? ' active' : '')}
              onClick={() => { setCur(c.id); if (innerWidth <= 768) setSideOpen(false) }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
              <div className="chat-item-info">
                <span className="chat-item-title">
                  {c.id === cur && loadingThread ? '⟳ Loading…' : c.title}
                </span>
              </div>
              <i className="del" title="Delete"
                onClick={e => { e.stopPropagation(); deleteThread(c.id) }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </i>
            </button>
          ))}
        </div>

        <div className="side-bottom">
          <button className="side-btn" onClick={() => { setDraft(S); dlg.current.showModal() }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
            Settings
          </button>
        </div>
      </aside>

      {/* Collapsed floating buttons */}
      {!sideOpen && (
        <div className="collapsed-toggle">
          <button onClick={() => setSideOpen(true)} title="Open sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
          </button>
          <button onClick={newChat} title="New chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      )}

      {/* ── Main ── */}
      <main>
        {/* Top bar */}
        <div className="topbar">
          {!sideOpen && <div className="topbar-left" style={{ width: 70 }} />}
          <span className="topbar-title">{active ? active.title.slice(0, 50) : ''}</span>
        </div>

        {/* Welcome or Chat view — composer is always mounted below for stable focus */}
        {isWelcome ? (
          <div className="welcome">
            <div className="welcome-logo">
              <BotIcon size={30} />
            </div>
            <h1>What can I help you with?</h1>
            <p className="welcome-sub">Your intelligent AI assistant — powered by LangGraph &amp; OpenAI</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s, i) => (
                <button key={i} className="sug-card"
                  onClick={() => { setInput(s.title); ta.current?.focus() }}>
                  <span className="sug-icon">{s.icon}</span>
                  <div>
                    <div className="sug-title">{s.title}</div>
                    <div className="sug-desc">{s.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-scroll" ref={scrollRef}>
            <div className="chat-msgs" onClick={onMsgClick}>
              {msgs.map((m, i) => <Message key={i} m={m} onRetry={() => retry(i)} />)}
              {live !== null && (
                live
                  ? <Message m={{ role: 'assistant', content: live, live: true }} />
                  : (
                    <div className="msg msg-ai">
                      <div className="ai-avatar"><BotIcon size={17} /></div>
                      <div className="msg-bubble">
                        <div className="dots"><span/><span/><span/></div>
                      </div>
                    </div>
                  )
              )}
            </div>
          </div>
        )}

        {/* Composer — always mounted, never conditionally removed */}
        <div className="composer-wrap">
          <div className="composer">
            <div className="composer-box">
              <textarea
                ref={ta} rows={1} value={input}
                placeholder={`Message ${S.name}…`}
                onChange={e => { setInput(e.target.value); fit() }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
              />
              <button
                className={`send-btn${busy ? ' stop-btn' : ''}`}
                aria-label={busy ? 'Stop' : 'Send'}
                onClick={submit}
                disabled={!input.trim() && !busy}
              >
                {busy
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                }
              </button>
            </div>
            <p className="disclaimer">{S.name} may make mistakes. Verify important information.</p>
          </div>
        </div>
      </main>

      {/* ── Settings Dialog ── */}
      <dialog ref={dlg}>
        <h2>⚙ Settings</h2>
        <label>Backend URL</label>
        <input type="text" value={draft.url} placeholder={DEF.url} onChange={e => setDraft({ ...draft, url: e.target.value })} />
        <label>Message Field Name</label>
        <input type="text" value={draft.msg} placeholder="message" onChange={e => setDraft({ ...draft, msg: e.target.value })} />
        <label>Auth Header</label>
        <input type="text" value={draft.auth} placeholder="Bearer your-token" onChange={e => setDraft({ ...draft, auth: e.target.value })} />
        <label>Assistant Name</label>
        <input type="text" value={draft.name} placeholder="Nexus AI" onChange={e => setDraft({ ...draft, name: e.target.value })} />
        <div className="hint">
          Sends: <code>POST</code> JSON with <code>message</code> + <code>conversation_id</code>.<br />
          Conversation history is persisted in <code>SQLite</code> on the backend — no history payload needed.
        </div>
        <div className="dlg-row">
          <button onClick={() => dlg.current.close()}>Cancel</button>
          <button className="pri" onClick={() => {
            const n = { url: draft.url.trim() || DEF.url, msg: draft.msg.trim() || 'message', auth: draft.auth.trim(), name: draft.name.trim() || 'Nexus AI' }
            setS(n); save(KS, n); dlg.current.close()
          }}>Save Changes</button>
        </div>
      </dialog>
    </>
  )
}
