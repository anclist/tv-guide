// health.json: probe streaks per stream and grab results per guide source, carried between runs
// through the published Pages site. Format: see openspec design §6.
const PRUNE_DAYS = 14

export const emptyHealth = () => ({ version: 1, generatedAt: null, streams: {}, guides: {}, summary: null })

// Streams are keyed by URL without query string or fragment, so tokenised links keep their history.
export function keyOfUrl(url) {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}
export const guideKey = (site, siteId) => `${site}|${siteId}`

export async function loadHealth(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const h = await res.json()
    if (h?.version !== 1) throw new Error(`unknown version ${h?.version}`)
    return { ...emptyHealth(), ...h }
  } catch (e) {
    console.log(`::warning::health.json not loaded (${e.message}), starting cold`)
    return emptyHealth()
  }
}

// 2 = delivered programmes last run, 0 = came back empty, 1 = no record.
export function guideProof(health, site, siteId) {
  const g = health.guides[guideKey(site, siteId)]
  if (!g) return 1
  if (g.programmes > 0) return 2
  return g.emptyStreak >= 1 ? 0 : 1
}

export const streakOf = (health, url) => health.streams[keyOfUrl(url)]?.streak ?? 0

// probes: Map/object key -> 'ok' | 'geo' | 'fail'. guideResults: Map/object guideKey -> programmes.
export function nextHealth(prev, probes, guideResults, { now = new Date(), summary = null } = {}) {
  const today = now.toISOString().slice(0, 10)
  const cutoff = new Date(now.getTime() - PRUNE_DAYS * 86400e3).toISOString().slice(0, 10)
  const keep = obj => Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => (v.seen ?? '') >= cutoff))
  const streams = keep(prev.streams)
  for (const [key, r] of entriesOf(probes)) {
    const p = streams[key] ?? { streak: 0, lastOk: null }
    if (r === 'ok') streams[key] = { streak: 0, lastOk: today, seen: today }
    else if (r === 'fail') streams[key] = { ...p, streak: (p.streak ?? 0) + 1, seen: today }
    else streams[key] = { ...p, seen: today } // geo: streak unchanged
  }
  const guides = keep(prev.guides)
  for (const [key, n] of entriesOf(guideResults)) {
    const p = guides[key] ?? { emptyStreak: 0, lastOk: null }
    guides[key] = n > 0
      ? { programmes: n, emptyStreak: 0, lastOk: today, seen: today }
      : { programmes: 0, emptyStreak: (p.emptyStreak ?? 0) + 1, lastOk: p.lastOk ?? null, seen: today }
  }
  return { version: 1, generatedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'), streams, guides, summary }
}

const entriesOf = x => (x instanceof Map ? x.entries() : Object.entries(x ?? {}))
