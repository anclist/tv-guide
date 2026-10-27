// Builds playlist.m3u, playlist-guided.m3u and custom.channels.xml from the iptv-org API,
// merged with the extra sources in config.json (extraSources). Guides for extra sources
// are written straight to guides/extra-<id>.xml. Hand-off files for later steps go to state/.
// Usage: node scripts/build-lists.mjs [outDir=public]
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { fetchText, parseM3u, parseXmltv, cleanName, normName, categoryFor } from './sources.mjs'
import { clusterCandidates, pickPair, feedOf, tzEquivalent, availability } from './select.mjs'
import { loadHealth, guideProof, keyOfUrl } from './health.mjs'
import { probeAll } from './probe.mjs'

const outDir = process.argv[2] ?? 'public'
const guidesDir = 'guides'
const stateDir = 'state'
const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'))
const API = 'https://iptv-org.github.io/api'
const SITES_MD = 'https://raw.githubusercontent.com/iptv-org/epg/master/SITES.md'
const from = Date.now() - 2 * 3600e3
const to = Date.now() + ((cfg.guideDays ?? 2) + 1) * 86400e3

async function getJson(name) {
  const res = await fetch(`${API}/${name}.json`)
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`)
  return res.json()
}

async function brokenSites() {
  const res = await fetch(SITES_MD)
  if (!res.ok) { console.warn(`SITES.md: HTTP ${res.status}, not skipping any site`); return new Set() }
  const broken = new Set()
  for (const row of (await res.text()).split('\n')) {
    const m = row.match(/sites\/([^"]+)">/)
    if (m && row.includes('🔴')) broken.add(m[1])
  }
  return broken
}

// A failing extra source is skipped with a warning, never fails the build.
async function loadSource(src) {
  try {
    const items = parseM3u(await fetchText(src.playlist))
    const epg = src.epg ? parseXmltv(await fetchText(src.epg)) : null
    console.log(`${src.id}: ${items.length} playlist entries${epg ? `, ${epg.channels.size} guide channels` : ''}`)
    return { src, items, epg }
  } catch (e) {
    console.log(`::warning::${src.id}: ${e.message}, skipping source`)
    return { src, items: [], epg: null }
  }
}

// "enabled": false turns a source off. Source order does not affect selection.
const extraCfg = (cfg.extraSources ?? []).filter(s => s.enabled !== false)
const [channels, streams, guides, feeds, logos, broken, extras, health] = await Promise.all([
  getJson('channels'), getJson('streams'), getJson('guides'), getJson('feeds'), getJson('logos'), brokenSites(),
  Promise.all(extraCfg.map(loadSource)), loadHealth(`${cfg.publicBaseUrl}/health.json`),
])
const exclude = new Set([...broken, ...cfg.excludeSites])
console.log(`skipping ${exclude.size} broken/excluded sites: ${[...exclude].join(', ') || 'none'}`)

const countries = new Set(cfg.countries)
const intlCats = new Set(cfg.intlCategories)
// Out-of-country news/sports are kept only if their main feed speaks one of these (ISO 639-3). Empty = any.
const intlLangs = new Set(cfg.intlLanguages ?? [])
const viewerCountry = cfg.viewerCountry ?? null
const viewerTz = cfg.viewerTimezone ?? null
const deadAfter = cfg.deadAfter ?? 3

const mainFeed = new Map()
const langsOf = new Map()
const feedCount = new Map()
const feedTzs = new Map() // "<channel>@<feed>" -> timezones
for (const f of feeds) {
  feedCount.set(f.channel, (feedCount.get(f.channel) ?? 0) + 1)
  feedTzs.set(`${f.channel}@${f.id}`, f.timezones ?? [])
  if (f.is_main) { mainFeed.set(f.channel, f.id); langsOf.set(f.channel, f.languages ?? []) }
}

// 1. Channel selection
const selected = new Map()
let langSkipped = 0
for (const c of channels) {
  if (c.closed || c.is_nsfw) continue
  const cats = c.categories ?? []
  if (countries.has(c.country)) { selected.set(c.id, c); continue }
  if (!cats.some(x => intlCats.has(x))) continue
  if (intlLangs.size && !langsOf.get(c.id)?.some(l => intlLangs.has(l))) { langSkipped++; continue }
  selected.set(c.id, c)
}
if (intlLangs.size) console.log(`skipped ${langSkipped} news/sports channels not in ${[...intlLangs].join(', ')}`)

// 2. Gather candidates from every source into one pool.
const qualityRank = q => parseInt(q ?? '0', 10) || 0
const playable = url => !/youtube\.com|youtu\.be|twitch\.tv|\[/.test(url)
const prio = site => { const i = cfg.sitePriority.indexOf(site); return i === -1 ? cfg.sitePriority.length : i }
const stats = Object.fromEntries(['iptv-org', ...extraCfg.map(s => s.id)].map(id => [id, { candidates: 0, skipped: 0, streams: 0, guides: 0 }]))

const iptvCands = []
for (const s of streams) {
  if (!s.channel || !selected.has(s.channel)) continue
  if (!playable(s.url)) { stats['iptv-org'].skipped++; continue }
  iptvCands.push({
    kind: 'stream', source: 'iptv-org', channel: s.channel, url: s.url, feed: s.feed ?? null,
    labels: s.labels ?? [], quality: qualityRank(s.quality), userAgent: s.user_agent, referrer: s.referrer,
  })
  stats['iptv-org'].candidates++
}
for (const g of guides) {
  if (!g.channel || !selected.has(g.channel) || exclude.has(g.site) || !g.site_id) continue
  iptvCands.push({
    kind: 'guide', source: 'iptv-org', channel: g.channel, site: g.site, siteId: g.site_id, lang: g.lang,
    feed: g.feed ?? null, proof: guideProof(health, g.site, g.site_id),
  })
}

const extraCands = []
for (const { src, items, epg } of extras) {
  const st = stats[src.id]
  // Extra-source guides are proven by data in hand: programmes inside the guide window.
  const epgIds = new Set(epg?.programmes.filter(p => p.stop >= from && p.start <= to).map(p => p.channel))
  for (const it of items) {
    if (!playable(it.url) || src.skipGroups?.some(g => it.group.startsWith(g))) { st.skipped++; continue }
    const base = { source: src.id, tvgId: it.tvgId, name: it.name, country: src.country ?? it.country, item: it }
    extraCands.push({
      kind: 'stream', ...base, url: it.url, userAgent: it.userAgent, referrer: it.referrer, quality: 0,
      labels: src.geoBlocked ? ['Geo-blocked'] : [], geoCountry: src.geoBlocked ? base.country : undefined,
      sourceCountry: src.country ?? null, preferStream: !!src.preferStream,
    })
    st.candidates++
    if (it.tvgId && epgIds.has(it.tvgId)) {
      extraCands.push({ kind: 'guide', ...base, site: src.id, external: true, origId: it.tvgId, feed: null, proof: 2 })
    }
  }
}

// 3. Cluster by channel. US and CA share FAST lineups (sameLineup), so they dedupe as one country.
const lineupOf = c => cfg.sameLineup?.find(g => g.includes(c))?.[0] ?? c
const lineupKey = (country, name) => { const n = normName(name); return n ? `${lineupOf(country)}|${n}` : null }
const { clusters, staleIds, nameMatches } = clusterCandidates({
  selected, allChannelIds: new Set(channels.map(c => c.id)), lineupKey, countries,
  iptv: iptvCands, extra: extraCands,
})

const ambiguousFeeds = []
const ambiguousSeen = new Set()
for (const cl of clusters.values()) {
  const seenGuides = new Set()
  cl.guides = cl.guides.filter(g => { const k = `${g.source}|${g.site}|${g.siteId ?? g.origId}`; return !seenGuides.has(k) && seenGuides.add(k) })
  for (const s of cl.streams) {
    const { feed, explicit } = cl.channel ? feedOf(s, mainFeed.get(cl.id)) : { feed: null, explicit: false }
    s.feed = feed
    if (cl.channel && !explicit && (feedCount.get(cl.id) ?? 0) > 1 && !ambiguousSeen.has(`${s.source}|${cl.id}`)) {
      ambiguousSeen.add(`${s.source}|${cl.id}`)
      ambiguousFeeds.push({ source: s.source, name: s.name ?? cl.channel.name, channel: `${cl.id}@${feed}`, feeds: feedCount.get(cl.id) })
    }
  }
}

// 4. Validate: probe every candidate stream. The effective streak includes this run's result.
const targets = []
for (const cl of clusters.values()) for (const s of cl.streams) targets.push({ key: s.url, url: s.url, userAgent: s.userAgent, referrer: s.referrer })
const t0 = Date.now()
const byUrl = await probeAll(targets, cfg.probe ?? {})
// Health is keyed by URL without query: any ok wins, then any fail, else geo.
const probes = new Map()
const order = { geo: 0, fail: 1, ok: 2 }
for (const [url, r] of byUrl) {
  const k = keyOfUrl(url)
  if (!probes.has(k) || order[r] > order[probes.get(k)]) probes.set(k, r)
}
const tally = { ok: 0, geo: 0, fail: 0 }
for (const r of byUrl.values()) tally[r]++
console.log(`probed ${byUrl.size} streams in ${Math.round((Date.now() - t0) / 1000)}s: ok=${tally.ok} geo=${tally.geo} fail=${tally.fail}`)
const effectiveStreak = url => {
  const k = keyOfUrl(url)
  const prev = health.streams[k]?.streak ?? 0
  const r = probes.get(k)
  return r === 'ok' ? 0 : r === 'fail' ? prev + 1 : prev
}

// 5. Pick one (stream, guide) pair per channel.
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const attr = v => String(v ?? '').replace(/"/g, "'")
const title = s => s.charAt(0).toUpperCase() + s.slice(1)

const logoFor = new Map()
for (const l of logos) {
  if (!selected.has(l.channel) || l.in_use === false) continue
  const cur = logoFor.get(l.channel)
  if (!cur || (l.feed == null && cur.feed != null)) logoFor.set(l.channel, l)
}

const ctxFor = cl => {
  const c = cl.channel
  return {
    deadAfter, viewerCountry, prio,
    channelCountry: c?.country ?? cl.streams[0].country,
    mainFeed: c ? mainFeed.get(cl.id) ?? null : null,
    feedMatchesViewerTz: f => !!viewerTz && !!c && (feedTzs.get(`${cl.id}@${f}`) ?? []).some(tz => tzEquivalent(tz, viewerTz)),
  }
}

const entries = []
const allDead = []
for (const cl of clusters.values()) {
  for (const s of cl.streams) s.streak = effectiveStreak(s.url)
  const c = cl.channel
  const ctx = ctxFor(cl)
  const { stream: s, guide: g, guides: ranked } = pickPair(cl, ctx)
  const anyLogo = [...cl.streams, ...cl.guides].map(x => x.item?.logo).find(Boolean)
  let e
  if (c) {
    const cats = c.categories ?? []
    const group = countries.has(c.country)
      ? `${c.country} · ${title(cats[0] ?? 'general')}`
      : `World · ${cats.includes('news') ? 'News' : 'Sports'}`
    const tvgId = g?.external ? `${g.source}:${g.origId}` : s.feed ? `${cl.id}@${s.feed}` : cl.id
    e = { id: cl.id, tvgId, name: c.name, group, logo: logoFor.get(cl.id)?.url || anyLogo }
  } else {
    const it = s.item
    const tvgId = g ? `${g.source}:${g.origId}` : `${s.source}:${s.tvgId || cl.key}`
    e = { id: cl.id, tvgId, name: cleanName(it.name), group: `${s.country} · ${title(categoryFor(it.group))}`, logo: it.logo || anyLogo }
  }
  // Still geo-blocked for the viewer (nothing better existed): keep it, but out of the way.
  if (availability(s, ctx.channelCountry, viewerCountry) === 0) e.group = `${c?.country ?? s.country} · Geo-blocked`
  Object.assign(e, { stream: s, guide: g, ranked })
  entries.push(e)
  stats[s.source].streams++
  if (g) stats[g.source].guides++
  if (cl.streams.every(x => x.streak >= deadAfter)) allDead.push({ id: e.tvgId, name: e.name, streams: cl.streams.length })
}

// 6. Custom groups (customGroups): listed channels move into the group, and each "<channel>@<feed>"
// in extraFeeds adds that feed as its own entry next to the channel's pick. Pinned entries go in the
// guided playlist even without a guide.
const feedName = new Map(feeds.map(f => [`${f.channel}@${f.id}`, f.name]))
for (const cg of cfg.customGroups ?? []) {
  const ids = new Set(cg.channels ?? [])
  for (const e of entries) if (ids.has(e.id)) Object.assign(e, { group: cg.name, pinned: true })
  for (const key of cg.extraFeeds ?? []) {
    const [id, feed] = key.split('@')
    const cl = clusters.get(id)
    const streams = cl?.channel ? cl.streams.filter(s => s.feed === feed) : []
    if (!streams.length) { console.log(`::warning::customGroups: no stream for ${key}, skipping`); continue }
    if (entries.some(e => e.id === id && e.stream.feed === feed)) continue // already the channel's pick
    const ctx = ctxFor(cl)
    const guides = cl.guides.filter(g => !g.external && (g.feed ?? ctx.mainFeed) === feed)
    const { stream: s, guide: g, guides: ranked } = pickPair({ streams, guides }, ctx)
    entries.push({
      id, tvgId: key, name: `${cl.channel.name} ${feedName.get(key) ?? feed}`, group: cg.name, pinned: true,
      logo: logoFor.get(id)?.url, stream: s, guide: g, ranked,
    })
    stats[s.source].streams++
    if (g) stats[g.source].guides++
  }
}
entries.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))

for (const [id, s] of Object.entries(stats)) {
  console.log(`${id}: candidates=${s.candidates} skipped=${s.skipped}, chosen streams=${s.streams} guides=${s.guides}`)
}
console.log(`name matches (${nameMatches.length}, first 30):\n  ${nameMatches.slice(0, 30).join('\n  ')}`)
console.log(`stale ids (${staleIds.length}):\n  ${staleIds.map(x => `${x.source}: ${x.tvgId} ("${x.name}")`).join('\n  ')}`)
console.log(`ambiguous feeds (${ambiguousFeeds.length}, first 30):\n  ${ambiguousFeeds.slice(0, 30).map(x => `${x.source} "${x.name}" -> ${x.channel} (${x.feeds} feeds)`).join('\n  ')}`)
console.log(`all-dead channels (${allDead.length}, first 30):\n  ${allDead.slice(0, 30).map(x => `${x.id} "${x.name}" (${x.streams} streams)`).join('\n  ')}`)

function m3u(list) {
  const lines = [`#EXTM3U x-tvg-url="${cfg.publicBaseUrl}/guide.xml.gz"`]
  for (const e of list) {
    lines.push(`#EXTINF:-1 tvg-id="${attr(e.tvgId)}" tvg-name="${attr(e.name)}"${e.logo ? ` tvg-logo="${attr(e.logo)}"` : ''} group-title="${attr(e.group)}",${e.name}`)
    if (e.stream.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${e.stream.userAgent}`)
    if (e.stream.referrer) lines.push(`#EXTVLCOPT:http-referrer=${e.stream.referrer}`)
    lines.push(e.stream.url)
  }
  return lines.join('\n') + '\n'
}

const guided = entries.filter(e => e.guide)
const grabbed = guided.filter(e => !e.guide.external) // extra-source guides are not grabbed
const channelXml = e => `  <channel site="${esc(e.guide.site)}" lang="${esc(e.guide.lang)}" xmltv_id="${esc(e.tvgId)}" site_id="${esc(e.guide.siteId)}">${esc(e.name)}</channel>`
const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>', ...grabbed.map(channelXml), '</channels>', ''].join('\n')

await mkdir(outDir, { recursive: true })
await writeFile(`${outDir}/playlist.m3u`, m3u(entries))
await writeFile(`${outDir}/playlist-guided.m3u`, m3u(entries.filter(e => e.guide || e.pinned)))
await writeFile('custom.channels.xml', xml)

// Extra-source guides: chosen channels only, ids prefixed, programmes trimmed to the guide window.
const keptGuideIds = new Map() // source id -> Set of original channel ids
for (const e of guided) {
  if (!e.guide.external) continue
  if (!keptGuideIds.has(e.guide.source)) keptGuideIds.set(e.guide.source, new Set())
  keptGuideIds.get(e.guide.source).add(e.guide.origId)
}
await rm(guidesDir, { recursive: true, force: true })
await mkdir(guidesDir, { recursive: true })
for (const { src, epg } of extras) {
  const kept = keptGuideIds.get(src.id)
  if (!epg || !kept?.size) continue
  const out = []
  for (const [id, x] of epg.channels) if (kept.has(id)) out.push(x.replace(`id="${id}"`, `id="${esc(`${src.id}:${id}`)}"`))
  let n = 0
  for (const p of epg.programmes) {
    if (!kept.has(p.channel) || p.stop < from || p.start > to) continue
    out.push(p.xml.replace(`channel="${p.channel}"`, `channel="${esc(`${src.id}:${p.channel}`)}"`)); n++
  }
  await writeFile(`${guidesDir}/extra-${src.id}.xml`,
    ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>', ...out, '</tv>', ''].join('\n'))
  console.log(`${guidesDir}/extra-${src.id}.xml: ${kept.size} channels, ${n} programmes`)
}

// Batches for the grabber: grouped by site, at most cfg.batchSize channels each,
// so one process never holds too much in memory and one bad site can't sink the run.
const batchSize = cfg.batchSize ?? 150
const bySiteList = new Map()
for (const e of grabbed) {
  const list = bySiteList.get(e.guide.site) ?? []
  list.push(e); bySiteList.set(e.guide.site, list)
}
const batches = []
let cur = []
for (const list of [...bySiteList.values()].sort((a, b) => b.length - a.length)) {
  for (let i = 0; i < list.length; i += batchSize) {
    const part = list.slice(i, i + batchSize)
    if (cur.length + part.length > batchSize) { if (cur.length) batches.push(cur); cur = [] }
    cur.push(...part)
  }
}
if (cur.length) batches.push(cur)
await rm('batches', { recursive: true, force: true })
await mkdir('batches', { recursive: true })
const batchOf = new Map() // tvgId -> batch name, so later steps can tell a crashed batch from an empty guide
for (const [i, b] of batches.entries()) {
  const name = `batch-${String(i + 1).padStart(2, '0')}`
  for (const e of b) batchOf.set(e.tvgId, name)
  await writeFile(`batches/${name}.channels.xml`,
    ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>', ...b.map(channelXml), '</channels>', ''].join('\n'))
}
console.log(`batches: ${batches.length} (max ${batchSize} channels each)`)

// Hand-off for fallback-batches.mjs, record-health.mjs and check-guide.mjs.
const guideMap = {}
for (const e of grabbed) {
  guideMap[e.tvgId] = {
    name: e.name, batch: batchOf.get(e.tvgId),
    candidates: e.ranked.filter(g => !g.external).map(g => ({ site: g.site, siteId: g.siteId, lang: g.lang })),
  }
}
const perSource = Object.fromEntries(Object.entries(stats).map(([id, s]) => [id, {
  ...s,
  staleIds: staleIds.filter(x => x.source === id).length,
  ambiguousFeeds: ambiguousFeeds.filter(x => x.source === id).length,
}]))
await rm(stateDir, { recursive: true, force: true })
await mkdir(stateDir, { recursive: true })
await writeFile(`${stateDir}/health.prev.json`, JSON.stringify(health))
await writeFile(`${stateDir}/probes.json`, JSON.stringify(Object.fromEntries(probes)))
await writeFile(`${stateDir}/guide-map.json`, JSON.stringify(guideMap))
await writeFile(`${stateDir}/diagnostics.json`, JSON.stringify({
  channels: entries.length, perSource, staleIds, ambiguousFeeds, allDead, nameMatches,
}, null, 1))

const bySite = {}
for (const e of guided) bySite[e.guide.site] = (bySite[e.guide.site] ?? 0) + 1
console.log(`channels: ${entries.length}, with guide: ${guided.length}, sites: ${Object.keys(bySite).length}`)
console.log('top sites:', Object.entries(bySite).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([s, n]) => `${s}=${n}`).join(' '))
