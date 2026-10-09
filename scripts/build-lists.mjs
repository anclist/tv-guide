// Builds playlist.m3u, playlist-guided.m3u and custom.channels.xml from the iptv-org API.
// Usage: node scripts/build-lists.mjs [outDir=public]
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'

const outDir = process.argv[2] ?? 'public'
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

const [channels, streams, guides, feeds, logos, broken] = await Promise.all([
  getJson('channels'), getJson('streams'), getJson('guides'), getJson('feeds'), getJson('logos'), brokenSites()
])
const exclude = new Set([...broken, ...cfg.excludeSites])
console.log(`skipping ${exclude.size} broken/excluded sites: ${[...exclude].join(', ') || 'none'}`)

const countries = new Set(cfg.countries)
const intlCats = new Set(cfg.intlCategories)

// 1. Channel selection
const selected = new Map()
for (const c of channels) {
  if (c.closed || c.is_nsfw) continue
  const cats = c.categories ?? []
  const inCountry = countries.has(c.country)
  const intl = cats.find(x => intlCats.has(x))
  if (inCountry || intl) selected.set(c.id, c)
}

// 2. One stream per channel: prefer no UA/referrer, then higher quality
const qualityRank = q => parseInt(q ?? '0', 10) || 0
const bestStream = new Map()
for (const s of streams) {
  if (!s.channel || !selected.has(s.channel)) continue
  const score = (s.user_agent || s.referrer ? 0 : 100000) + qualityRank(s.quality) - (s.labels?.length ? 1 : 0)
  const cur = bestStream.get(s.channel)
  if (!cur || score > cur.score) bestStream.set(s.channel, { ...s, score })
}

const mainFeed = new Map()
for (const f of feeds) if (f.is_main) mainFeed.set(f.channel, f.id)

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
for (const [id, s] of bestStream) {
  const c = selected.get(id)
  const feed = s.feed ?? mainFeed.get(id)
  const tvgId = feed ? `${id}@${feed}` : id
  const cats = c.categories ?? []
  const group = countries.has(c.country)
    ? `${c.country} · ${title(cats[0] ?? 'general')}`
    : `World · ${cats.includes('news') ? 'News' : 'Sports'}`
  entries.push({ id, tvgId, name: c.name, group, logo: logoFor.get(id)?.url, stream: s, guide: guideFor.get(id) })
}
entries.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))

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
const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>',
  ...guided.map(e => `  <channel site="${esc(e.guide.site)}" lang="${esc(e.guide.lang)}" xmltv_id="${esc(e.tvgId)}" site_id="${esc(e.guide.site_id)}">${esc(e.name)}</channel>`),
  '</channels>', ''].join('\n')

await mkdir(outDir, { recursive: true })
await writeFile(`${outDir}/playlist.m3u`, m3u(entries))
await writeFile(`${outDir}/playlist-guided.m3u`, m3u(guided))
await writeFile('custom.channels.xml', xml)

// Batches for the grabber: grouped by site, at most cfg.batchSize channels each,
// so one process never holds too much in memory and one bad site can't sink the run.
const batchSize = cfg.batchSize ?? 150
const bySiteList = new Map()
for (const e of guided) {
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
console.log('top sites:', Object.entries(bySite).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s, n]) => `${s}=${n}`).join(' '))
