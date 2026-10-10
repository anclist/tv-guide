// Builds playlist.m3u, playlist-guided.m3u and custom.channels.xml from the iptv-org API,
// merged with the extra sources in config.json (extraSources). Guides for extra sources
// are written straight to guides/extra-<id>.xml.
// Usage: node scripts/build-lists.mjs [outDir=public]
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { fetchText, parseM3u, parseXmltv, cleanName, normName, categoryFor } from './sources.mjs'

const outDir = process.argv[2] ?? 'public'
const guidesDir = 'guides'
const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'))
const API = 'https://iptv-org.github.io/api'
const SITES_MD = 'https://raw.githubusercontent.com/iptv-org/epg/master/SITES.md'

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

// Free-TV (preferStream) sources go first so their streams win. "enabled": false turns a source off.
const extraCfg = (cfg.extraSources ?? []).filter(s => s.enabled !== false).sort((a, b) => !!b.preferStream - !!a.preferStream)
const [channels, streams, guides, feeds, logos, broken, extras] = await Promise.all([
  getJson('channels'), getJson('streams'), getJson('guides'), getJson('feeds'), getJson('logos'), brokenSites(),
  Promise.all(extraCfg.map(loadSource))
])
const exclude = new Set([...broken, ...cfg.excludeSites])
console.log(`skipping ${exclude.size} broken/excluded sites: ${[...exclude].join(', ') || 'none'}`)

const countries = new Set(cfg.countries)
const intlCats = new Set(cfg.intlCategories)
// Out-of-country news/sports are kept only if their main feed speaks one of these (ISO 639-3). Empty = any.
const intlLangs = new Set(cfg.intlLanguages ?? [])

const mainFeed = new Map()
const langsOf = new Map()
for (const f of feeds) if (f.is_main) { mainFeed.set(f.channel, f.id); langsOf.set(f.channel, f.languages ?? []) }

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

// 2. One stream per channel: prefer no UA/referrer, then higher quality
const qualityRank = q => parseInt(q ?? '0', 10) || 0
const bestStream = new Map()
for (const s of streams) {
  if (!s.channel || !selected.has(s.channel)) continue
  const score = (s.user_agent || s.referrer ? 0 : 100000) + qualityRank(s.quality) - (s.labels?.length ? 1 : 0)
  const cur = bestStream.get(s.channel)
  if (!cur || score > cur.score) bestStream.set(s.channel, { ...s, score })
}

// 2b. Preferred-stream sources (Free-TV) replace or fill iptv-org streams. Matched by
// tvg-id (Free-TV uses iptv-org ids), else by country + normalized name.
const keyOf = (country, name) => { const n = normName(name); return n ? `${country}|${n}` : null }
// Countries in one sameLineup group share FAST lineups (e.g. US/CA), so extra sources dedupe across them.
const lineupOf = c => cfg.sameLineup?.find(g => g.includes(c))?.[0] ?? c
const lineupKey = (country, name) => keyOf(lineupOf(country), name)
const playable = url => !/youtube\.com|youtu\.be|twitch\.tv|\[/.test(url)
const stats = Object.fromEntries(extraCfg.map(s => [s.id, { streams: 0, filled: 0, added: 0, guides: 0, dup: 0, skipped: 0 }]))
const nameMatches = []

const iptvByKey = new Map()
for (const c of selected.values()) {
  for (const n of [c.name, ...(c.alt_names ?? [])]) {
    const k = keyOf(c.country, n)
    if (k && !iptvByKey.has(k)) iptvByKey.set(k, c.id)
  }
}

const leftovers = new Map() // source id -> items not matched to iptv-org
for (const { src, items } of extras.filter(x => x.src.preferStream)) {
  const st = stats[src.id]
  const rest = []
  for (const it of items) {
    if (!playable(it.url)) { st.skipped++; continue }
    const country = src.country ?? it.country
    const id = selected.has(it.tvgId) ? it.tvgId : iptvByKey.get(keyOf(country, it.name))
    if (!id) { rest.push(it); continue }
    const cur = bestStream.get(id)
    if (cur?.source) { st.dup++; continue } // first URL from the preferred source wins
    if (id !== it.tvgId) nameMatches.push(`${src.id} "${it.name}" -> ${id}`)
    cur ? st.streams++ : st.filled++
    bestStream.set(id, { channel: id, url: it.url, user_agent: it.userAgent, referrer: it.referrer, source: src.id })
  }
  leftovers.set(src.id, rest)
}

const logoFor = new Map()
for (const l of logos) {
  if (!selected.has(l.channel) || l.in_use === false) continue
  const cur = logoFor.get(l.channel)
  if (!cur || (l.feed == null && cur.feed != null)) logoFor.set(l.channel, l)
}

// 3. Guide entry per channel by site priority (same feed preferred)
const prio = site => { const i = cfg.sitePriority.indexOf(site); return i === -1 ? cfg.sitePriority.length : i }
const guideFor = new Map()
for (const g of guides) {
  if (!g.channel || !bestStream.has(g.channel) || exclude.has(g.site) || !g.site_id) continue
  const s = bestStream.get(g.channel)
  const feed = s.feed ?? mainFeed.get(g.channel)
  const score = prio(g.site) * 10 + (g.feed === feed ? 0 : 1)
  const cur = guideFor.get(g.channel)
  if (!cur || score < cur.score) guideFor.set(g.channel, { ...g, score })
}

// 4. Build entries
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const attr = v => String(v ?? '').replace(/"/g, "'")
const title = s => s.charAt(0).toUpperCase() + s.slice(1)
const entries = []
const entryByKey = new Map()
const usedUrls = new Set()
for (const [id, s] of bestStream) {
  const c = selected.get(id)
  const feed = s.feed ?? mainFeed.get(id)
  const tvgId = feed ? `${id}@${feed}` : id
  const cats = c.categories ?? []
  const group = countries.has(c.country)
    ? `${c.country} · ${title(cats[0] ?? 'general')}`
    : `World · ${cats.includes('news') ? 'News' : 'Sports'}`
  const e = { id, tvgId, name: c.name, group, logo: logoFor.get(id)?.url, stream: s, guide: guideFor.get(id), preferred: !!s.source }
  entries.push(e)
  usedUrls.add(s.url)
  for (const n of [c.name, ...(c.alt_names ?? [])]) {
    const k = lineupKey(c.country, n)
    if (k && !entryByKey.has(k)) entryByKey.set(k, e)
  }
}

// 4b. Extra sources: add new channels, or give a guide to channels that lack one.
// Extra-source tvg-ids are "<source id>:<original id>" so they never collide with iptv-org ids.
const keptGuideIds = new Map() // source id -> Set of original channel ids
for (const { src, items, epg } of extras) {
  const st = stats[src.id]
  const epgIds = new Set(epg?.programmes.map(p => p.channel))
  const kept = new Set()
  const seen = new Set()
  for (const it of src.preferStream ? leftovers.get(src.id) ?? [] : items) {
    const country = src.country ?? it.country
    const key = lineupKey(country, it.name)
    const dedupe = it.tvgId || key
    if (!key || !playable(it.url) || usedUrls.has(it.url) || !countries.has(country) ||
        src.skipGroups?.some(g => it.group.startsWith(g))) { st.skipped++; continue }
    if (seen.has(dedupe)) { st.dup++; continue } // same channel listed with several URLs
    seen.add(dedupe)
    const hasGuide = !!it.tvgId && epgIds.has(it.tvgId)
    const tvgId = it.tvgId ? `${src.id}:${it.tvgId}` : ''
    const stream = { url: it.url, user_agent: it.userAgent, referrer: it.referrer, source: src.id }
    const e = entryByKey.get(key)
    if (e) {
      if (e.guide || !hasGuide) { st.dup++; continue }
      e.tvgId = tvgId
      e.guide = { site: src.id, external: true }
      if (!e.preferred) { usedUrls.add(it.url); e.stream = stream }
      e.logo ||= it.logo
      kept.add(it.tvgId); st.guides++
      if (nameMatches.length < 200) nameMatches.push(`${src.id} "${it.name}" -> ${e.id} (guide)`)
      continue
    }
    const ne = {
      id: tvgId || `${src.id}:${key}`, tvgId, name: cleanName(it.name),
      group: `${country} · ${title(categoryFor(it.group))}`, logo: it.logo, stream,
      guide: hasGuide ? { site: src.id, external: true } : undefined, preferred: !!src.preferStream,
    }
    entries.push(ne); entryByKey.set(key, ne); usedUrls.add(it.url)
    if (hasGuide) kept.add(it.tvgId)
    st.added++
  }
  keptGuideIds.set(src.id, kept)
}
entries.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))

for (const [id, s] of Object.entries(stats)) {
  console.log(`${id}: iptv-org streams replaced=${s.streams} filled=${s.filled}, guides attached=${s.guides}, ` +
    `new channels=${s.added}, duplicates=${s.dup}, skipped=${s.skipped}`)
}
console.log(`name matches (${nameMatches.length}, first 30):\n  ${nameMatches.slice(0, 30).join('\n  ')}`)

function m3u(list) {
  const lines = [`#EXTM3U x-tvg-url="${cfg.publicBaseUrl}/guide.xml.gz"`]
  for (const e of list) {
    lines.push(`#EXTINF:-1 tvg-id="${attr(e.tvgId)}" tvg-name="${attr(e.name)}"${e.logo ? ` tvg-logo="${attr(e.logo)}"` : ''} group-title="${attr(e.group)}",${e.name}`)
    if (e.stream.user_agent) lines.push(`#EXTVLCOPT:http-user-agent=${e.stream.user_agent}`)
    if (e.stream.referrer) lines.push(`#EXTVLCOPT:http-referrer=${e.stream.referrer}`)
    lines.push(e.stream.url)
  }
  return lines.join('\n') + '\n'
}

const guided = entries.filter(e => e.guide)
const grabbed = guided.filter(e => !e.guide.external) // extra-source guides are not grabbed
const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>',
  ...grabbed.map(e => `  <channel site="${esc(e.guide.site)}" lang="${esc(e.guide.lang)}" xmltv_id="${esc(e.tvgId)}" site_id="${esc(e.guide.site_id)}">${esc(e.name)}</channel>`),
  '</channels>', ''].join('\n')

await mkdir(outDir, { recursive: true })
await writeFile(`${outDir}/playlist.m3u`, m3u(entries))
await writeFile(`${outDir}/playlist-guided.m3u`, m3u(guided))
await writeFile('custom.channels.xml', xml)

// Extra-source guides: kept channels only, ids prefixed, programmes trimmed to guideDays.
await rm(guidesDir, { recursive: true, force: true })
await mkdir(guidesDir, { recursive: true })
const from = Date.now() - 2 * 3600e3
const to = Date.now() + ((cfg.guideDays ?? 2) + 1) * 86400e3
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
for (const [i, b] of batches.entries()) {
  const body = b.map(e => `  <channel site="${esc(e.guide.site)}" lang="${esc(e.guide.lang)}" xmltv_id="${esc(e.tvgId)}" site_id="${esc(e.guide.site_id)}">${esc(e.name)}</channel>`)
  await writeFile(`batches/batch-${String(i + 1).padStart(2, '0')}.channels.xml`,
    ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>', ...body, '</channels>', ''].join('\n'))
}
console.log(`batches: ${batches.length} (max ${batchSize} channels each)`)

const bySite = {}
for (const e of guided) bySite[e.guide.site] = (bySite[e.guide.site] ?? 0) + 1
console.log(`channels: ${entries.length}, with guide: ${guided.length}, sites: ${Object.keys(bySite).length}`)
console.log('top sites:', Object.entries(bySite).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([s, n]) => `${s}=${n}`).join(' '))
