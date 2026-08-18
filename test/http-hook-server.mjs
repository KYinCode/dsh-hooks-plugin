// Local HTTP hook test server: POSTs the hook input JSON, replies with a deny
// decision so dsh-hooks' http hook path is exercised end-to-end.
// Run: node test/http-hook-server.mjs [port]
import { createServer } from 'node:http'
const port = Number(process.argv[2] || 18765)
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = {} }
    // DSH's read tool schema uses `file_path` (not `path`). Read both for
    // robustness: the official tool puts the target under `file_path`.
    const input = parsed.tool_input || {}
    const p = String(input.file_path || input.path || '')
    const denied = typeof parsed.tool_name === 'string' && parsed.tool_name.includes('read') && (p.includes('dsh-denied') || p.includes('http-deny'))
    console.log(`[http-hook-server] ${new Date().toISOString()} tool_name=${parsed.tool_name} path=${p} denied=${denied}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (denied) {
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'denied by http hook test server' } }))
      return
    }
    res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: 'http-hook-echo' } }))
  })
})
server.listen(port, '127.0.0.1', () => {
  console.log(`http-hook-server listening on http://127.0.0.1:${port}`)
})
