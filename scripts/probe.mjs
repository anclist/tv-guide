// Stream liveness probe from the build runner. Results: 'ok', 'geo' (401/403/451, likely a geo
// block from the US runner, never counted as a failure) or 'fail'.
// Usage as CLI: node scripts/probe.mjs <url> [url ...]

// Streams without their own user-agent get a browser-like one; many origins reject Node's default.
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GEO = new Set([401, 403, 451])

export async function probe({ url, userAgent, referrer }, { timeoutMs = 8000 } = {}) {
  const headers = { 'user-agent': userAgent || DEFAULT_UA }
  if (referrer) headers.referer = referrer
  try {
    const res = await fetch(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(timeoutMs) })
    if (GEO.has(res.status) || !res.ok || !res.body) {
      res.body?.cancel().catch(() => {})
      return GEO.has(res.status) ? 'geo' : 'fail'
    }
    const type = res.headers.get('content-type') ?? ''
    const reader = res.body.getReader()
    const { value } = await reader.read()
    reader.cancel().catch(() => {})
    const head = Buffer.from(value ?? []).subarray(0, 1024).toString('latin1')
    return head.includes('#EXTM3U') || /^video\/|mp2t/i.test(type) ? 'ok' : 'fail'
  } catch {
    return 'fail' // timeout, DNS, TLS, unsupported scheme
  }
}

// Probes each target (deduped by `key`) with a concurrency cap. Returns Map key -> result.
export async function probeAll(targets, { timeoutMs = 8000, concurrency = 32 } = {}) {
  const queue = [...new Map(targets.map(t => [t.key, t])).values()]
  const out = new Map()
  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const t = queue[next++]
      out.set(t.key, await probe(t, { timeoutMs }))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await probeAll(process.argv.slice(2).map(url => ({ key: url, url })))
  for (const [url, r] of res) console.log(`${r}\t${url}`)
}
