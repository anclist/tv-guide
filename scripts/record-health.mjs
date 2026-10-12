// Writes health.json for the next run: probe streaks per stream, programme counts per guide
// source, and the summary counts check-guide.mjs compares day over day.
// Usage: node scripts/record-health.mjs <out health.json> <merged guide.xml> <playlist-guided.m3u>
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { nextHealth, guideKey } from './health.mjs'

const [out = 'public/health.json', guidePath = 'public/guide.xml', playlistPath = 'public/playlist-guided.m3u'] = process.argv.slice(2)
const readJson = async p => JSON.parse(await readFile(p, 'utf8'))
const [prev, probes, guideMap, diag] = await Promise.all(
  ['health.prev.json', 'probes.json', 'guide-map.json', 'diagnostics.json'].map(f => readJson(`state/${f}`)))

const withProg = new Map()
for (const m of (await readFile(guidePath, 'utf8')).matchAll(/<programme[^>]*channel="([^"]+)"/g)) {
  withProg.set(m[1], (withProg.get(m[1]) ?? 0) + 1)
}

// A fallback was only grabbed for channels empty in the first pass, so the merged count is the
// fallback's; otherwise it belongs to the first-ranked candidate. A batch whose grab crashed
// wrote no file: its channels are left unrecorded rather than marked empty.
const ran = batch => !batch || existsSync(`guides/${batch}.xml`)
const guideResults = new Map()
let fallbackTried = 0, fallbackUsed = 0, unrecorded = 0
for (const [tvgId, g] of Object.entries(guideMap)) {
  const first = g.candidates[0]
  const n = withProg.get(tvgId) ?? 0
  if (g.fallback) {
    fallbackTried++
    if (n > 0) fallbackUsed++
    if (ran(g.batch)) guideResults.set(guideKey(first.site, first.siteId), 0)
    else unrecorded++
    if (ran(g.fallback.batch)) guideResults.set(guideKey(g.fallback.site, g.fallback.siteId), n)
    else unrecorded++
  } else if (first) {
    if (ran(g.batch)) guideResults.set(guideKey(first.site, first.siteId), n)
    else unrecorded++
  }
}
if (unrecorded) console.log(`::warning::${unrecorded} guide results not recorded (their grab batch crashed)`)

let guided = 0, withGuide = 0
for (const m of (await readFile(playlistPath, 'utf8')).matchAll(/tvg-id="([^"]*)"/g)) {
  guided++
  if (withProg.has(m[1])) withGuide++
}

const summary = {
  channels: diag.channels, guided, withGuide,
  staleIds: diag.staleIds.length, ambiguousFeeds: diag.ambiguousFeeds.length, allDead: diag.allDead.length,
  fallbackTried, fallbackUsed,
}
const health = nextHealth(prev, probes, guideResults, { summary })
await writeFile(out, JSON.stringify(health))
console.log(`wrote ${out}: ${Object.keys(health.streams).length} streams, ${Object.keys(health.guides).length} guide sources`)
console.log(JSON.stringify(summary))
