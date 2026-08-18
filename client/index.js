// dsh-hooks — Client half (browser), prebuilt factory-form CJS bundle.
//
// Discovered through package.json `dsh.client` (platform "web") and
// `exports["./client"]`; served by @deepseek-ai/dsh-client-modules at
// /plugins/dsh-hooks-plugin/client.js?rev=<hash> and registered into the
// browser module table by the vendored cordis Loader. The registration id
// MUST equal the package name (the boot-graph row id), which is why this
// bundle's `id` is `dsh-hooks-plugin` even though the product is called
// "dsh-hooks" (the /dsh-hooks API + log namespace below).
// The factory requires only table words (react is a shell-seeded static
// module); no bundler needed.
//
// UI: floating console on the `shell.overlay` list slot (additive, root
// scope, click-through until the entry opts into pointer events), per
// hooks-design.md §7.3. It polls the host's /dsh-hooks/recent memory records
// (cap 100) every 1.2s and dedupes by record id.
//
// Layout (fixed, from §7.3): right 20 / bottom 120 (base of the drag
// transform), fixed width 360px, outer maxHeight 340, list 220px inner
// scroll, stdout 160px inner scroll; header draggable via pointer capture
// (buttons excluded); row = decision icon + event(100px ellipsis) + name +
// elapsed + expand button right, stdout on its own wrapped line.

window.__ModuleLoader__.load({
  id: 'dsh-hooks-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const POLL_MS = 1200
    const MAX_ROWS = 100

    const COL_BAD = '#e5484d'
    const COL_GOOD = '#30a46c'
    const COL_MUTED = '#8b949e'
    const COL_BG = 'rgba(22, 24, 28, 0.96)'
    const COL_BORDER = '#34383f'
    const COL_TEXT = '#e6e8eb'
    const COL_STDOUT = '#17191d'

    function toneOf(rec) {
      const d = rec.decision
      if (d === 'deny' || d === 'block' || d === 'ask') return 'bad'
      if (d === 'allow' || d === 'accept' || d === 'continue') return 'good'
      return 'none'
    }

    function displayName(rec) {
      const raw = rec.name || rec.type || ''
      return raw.length > 34 ? raw.slice(0, 15) + '…' + raw.slice(-16) : raw
    }

    function latestEntry(entries) {
      return entries.length ? entries[entries.length - 1] : undefined
    }

    function HooksConsole() {
      const [entries, setEntries] = React.useState([])
      const [expanded, setExpanded] = React.useState(false)
      const [openId, setOpenId] = React.useState(undefined)
      const [pos, setPos] = React.useState({ x: 20, y: 120 })
      const drag = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const res = await fetch('/dsh-hooks/recent', { cache: 'no-store' })
            if (!res.ok) return
            const data = await res.json()
            if (!alive) return
            const list = Array.isArray(data.entries) ? data.entries : []
            setEntries((prev) => {
              const seen = new Map(prev.map((e) => [e.id, e]))
              for (const e of list) if (e && e.id) seen.set(e.id, e)
              const out = [...seen.values()]
              return out.length > MAX_ROWS ? out.slice(out.length - MAX_ROWS) : out
            })
          } catch { /* transient network — keep last snapshot */ }
        }
        tick()
        const iv = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(iv) }
      }, [])

      const onHeaderPointerDown = (e) => {
        if (e.target.closest('button')) return
        e.preventDefault()
        drag.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y }
        // Grab-anywhere drag: window listeners keep tracking after the pointer
        // leaves the header. Equivalent to setPointerCapture but robust (no
        // InvalidPointerId failure on synthetic/pre-released pointers).
        window.addEventListener('pointermove', onHeaderPointerMove)
        window.addEventListener('pointerup', onHeaderPointerUp)
        window.addEventListener('pointercancel', onHeaderPointerUp)
      }
      const onHeaderPointerMove = (e) => {
        const d = drag.current
        if (!d) return
        setPos({ x: d.baseX + e.clientX - d.startX, y: d.baseY + e.clientY - d.startY })
      }
      const onHeaderPointerUp = () => {
        drag.current = null
        window.removeEventListener('pointermove', onHeaderPointerMove)
        window.removeEventListener('pointerup', onHeaderPointerUp)
        window.removeEventListener('pointercancel', onHeaderPointerUp)
      }

      const latest = latestEntry(entries)
      const latestTone = latest ? toneOf(latest) : 'none'
      const denyCount = entries.filter((e) => toneOf(e) === 'bad').length

      const containerStyle = {
        position: 'fixed',
        left: 0,
        top: 0,
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        width: 360,
        maxHeight: 340,
        zIndex: 9999,
        overflow: 'hidden',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        color: COL_TEXT,
        background: COL_BG,
        border: '1px solid ' + COL_BORDER,
        borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
      }
      const headerStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        cursor: 'grab',
        userSelect: 'none',
        borderBottom: '1px solid ' + COL_BORDER,
        background: 'rgba(255,255,255,0.04)',
        flexWrap: 'nowrap',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }
      const headerText = (color, text) => React.createElement('span', { style: { color: color || COL_TEXT, flex: '0 0 auto' } }, text)
      const listStyle = {
        height: 220,
        overflowY: 'auto',
        boxSizing: 'border-box',
      }
      const rowWrapStyle = { borderBottom: '1px solid rgba(255,255,255,0.05)' }
      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        flexWrap: 'wrap',
      }
      const eventStyle = { width: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 0 auto', color: COL_MUTED }
      const nameStyle = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      const timeStyle = { flex: '0 0 auto', color: COL_MUTED, fontWeight: 600 }
      const toggleStyle = { flex: '0 0 auto', marginLeft: 'auto', background: 'transparent', color: COL_TEXT, border: 'none', cursor: 'pointer', padding: '1px 4px' }
      const stdoutStyle = {
        margin: 0,
        maxHeight: 160,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.5,
        padding: '6px 10px',
        background: COL_STDOUT,
        color: '#c8cdd3',
        fontSize: 12,
        boxSizing: 'border-box',
      }
      const emptyStyle = { padding: '10px', color: COL_MUTED }

      const toggleBtn = React.createElement(
        'button',
        {
          key: 'toggle',
          style: {
            flex: '0 0 auto',
            background: 'transparent',
            color: COL_TEXT,
            border: '1px solid ' + COL_BORDER,
            borderRadius: 4,
            cursor: 'pointer',
            padding: '2px 8px',
            marginLeft: 'auto',
          },
          onClick: () => setExpanded((v) => !v),
        },
        expanded ? '收起' : '展开',
      )

      const headerChildren = [
        headerText(undefined, '🔌 Hooks'),
        headerText(COL_MUTED, '· ' + entries.length + ' 条'),
        headerText(latestTone === 'bad' ? COL_BAD : latestTone === 'good' ? COL_GOOD : COL_MUTED, latest ? (latest.decision || '-') : 'idle'),
        denyCount > 0 ? headerText(COL_BAD, '· ' + denyCount + ' 拦截') : null,
        toggleBtn,
      ].filter(Boolean)

      const header = React.createElement(
        'div',
        {
          key: 'header',
          style: headerStyle,
          onPointerDown: onHeaderPointerDown,
        },
        ...headerChildren,
      )

      const rows = expanded
        ? entries.slice().reverse().map((rec) => {
            const tone = toneOf(rec)
            const icon = tone === 'bad' ? '⛔' : tone === 'good' || (rec.status === 0 && !rec.stderr) ? '✓' : '·'
            const iconColor = tone === 'bad' ? COL_BAD : tone === 'good' ? COL_GOOD : COL_MUTED
            const open = openId === rec.id
            const row = React.createElement(
              'div',
              { key: 'row', style: rowStyle },
              React.createElement('span', { key: 'ic', style: { color: iconColor, flex: '0 0 auto', width: 16, textAlign: 'center' } }, icon),
              React.createElement('span', { key: 'ev', style: eventStyle }, rec.event || ''),
              React.createElement('span', { key: 'nm', style: nameStyle }, displayName(rec)),
              rec.elapsedMs != null ? React.createElement('span', { key: 'tm', style: timeStyle }, rec.elapsedMs + 'ms') : null,
              React.createElement(
                'button',
                {
                  key: 'x',
                  style: toggleStyle,
                  onClick: (e) => {
                    e.stopPropagation()
                    setOpenId(open ? undefined : rec.id)
                  },
                },
                open ? '▾' : '▸',
              ),
            )
            const stdoutBody = rec.stdout || ''
            const stderrBody = rec.stderr || ''
            const body = stdoutBody || stderrBody
              ? React.createElement('pre', { key: 'out', style: stdoutStyle }, stdoutBody + (stderrBody ? (stdoutBody ? '\n' : '') + stderrBody : '') || '\u00a0')
              : null
            return React.createElement('div', { key: rec.id, style: rowWrapStyle }, row, open ? body : null)
          })
        : null

      const list = expanded ? React.createElement('div', { key: 'list', style: listStyle }, rows.length ? rows : React.createElement('div', { key: 'empty', style: emptyStyle }, '暂无记录')) : null

      return React.createElement('div', { style: containerStyle }, header, list)
    }

    /** Required services: the slot registry (provided by @deepseek-ai/dsh-client-runtime). */
    const inject = ['slots']

    /**
     * Client plugin body: one additive entry into the frame-wide floating
     * `shell.overlay` list slot. Registered under the plugin's own fiber, so
     * plugin stop/update removes the contribution.
     */
    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-hooks',
            order: 1000,
          },
          HooksConsole,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.HooksConsole = HooksConsole
    return module.exports
  },
})
