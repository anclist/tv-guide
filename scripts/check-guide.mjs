// Counts playlist channels that have programmes in the guide. Writes a Markdown summary.
// Usage: node scripts/check-guide.mjs <guide.xml> <playlist.m3u>
import { readFile, appendFile } from 'node:fs/promises'

const [guidePath = 'public/guide.xml', playlistPath = 'public/playlist-guided.m3u'] = process.argv.slice(2)
const guide = await readFile(guidePath, 'utf8')
const withProg = new Map()
for (const m of guide.matchAll(/<programme[^>]*channel="([^"]+)"/g)) withProg.set(m[1], (withProg.get(m[1]) ?? 0) + 1)

const groups = new Map()
let total = 0, ok = 0
for (const m of (await readFile(playlistPath, 'utf8')).matchAll(/tvg-id="([^"]*)"[^\n]*group-title="([^"]*)"/g)) {
  const [, id, group] = m
  const g = groups.get(group) ?? { total: 0, ok: 0 }
  g.total++; total++
  if (withProg.has(id)) { g.ok++; ok++ }
  groups.set(group, g)
}
const programmes = [...withProg.values()].reduce((a, b) => a + b, 0)
const lines = [`### Guide coverage`, '', `${ok} of ${total} playlist channels have programmes (${programmes} programmes total).`, '',
  '| Group | With guide | Channels |', '|---|---:|---:|',
  ...[...groups].sort().map(([g, v]) => `| ${g} | ${v.ok} | ${v.total} |`), '']
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'))
if (programmes === 0) { console.error('guide has no programmes'); process.exit(1) }
