// Second grab pass: channels whose first-pass guide came back empty are re-grabbed from their
// next-ranked guide site, under the same xmltv_id. Writes batches/fallback-NN.channels.xml and
// records the first-pass counts and chosen fallbacks in state/guide-map.json.
// Usage: node scripts/fallback-batches.mjs <first-pass guide.xml ...>
import { readFile, writeFile } from 'node:fs/promises'

const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'))
const mapPath = 'state/guide-map.json'
const guideMap = JSON.parse(await readFile(mapPath, 'utf8'))

const counts = new Map()
for (const file of process.argv.slice(2)) {
  let xml
  try { xml = await readFile(file, 'utf8') } catch { console.warn(`skip missing ${file}`); continue }
  for (const m of xml.matchAll(/<programme[^>]*channel="([^"]+)"/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
}

const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const picked = []
let empty = 0
for (const [tvgId, g] of Object.entries(guideMap)) {
  g.firstPass = counts.get(tvgId) ?? 0
  delete g.fallback
  if (g.firstPass > 0) continue
  empty++
  if (cfg.fallbackGrab === false) continue
  const first = g.candidates[0]
  const next = g.candidates.slice(1).find(c => c.site !== first?.site)
  if (!next) continue
  g.fallback = next
  picked.push({ tvgId, name: g.name, ...next })
}
await writeFile(mapPath, JSON.stringify(guideMap))

const batchSize = cfg.batchSize ?? 150
picked.sort((a, b) => a.site.localeCompare(b.site))
for (let i = 0; i < picked.length; i += batchSize) {
  const body = picked.slice(i, i + batchSize).map(c =>
    `  <channel site="${esc(c.site)}" lang="${esc(c.lang)}" xmltv_id="${esc(c.tvgId)}" site_id="${esc(c.siteId)}">${esc(c.name)}</channel>`)
  await writeFile(`batches/fallback-${String(i / batchSize + 1).padStart(2, '0')}.channels.xml`,
    ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>', ...body, '</channels>', ''].join('\n'))
}
console.log(`first pass: ${empty} of ${Object.keys(guideMap).length} grabbed channels empty, ` +
  `${picked.length} queued for fallback${cfg.fallbackGrab === false ? ' (fallbackGrab off)' : ''}`)
