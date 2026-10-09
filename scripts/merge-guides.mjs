// Merges XMLTV files into one. Usage: node scripts/merge-guides.mjs <out.xml> <in1.xml> [in2.xml ...]
import { readFile, writeFile } from 'node:fs/promises'

const [out, ...inputs] = process.argv.slice(2)
const channels = new Map()
const programmes = []
for (const file of inputs) {
  let xml
  try { xml = await readFile(file, 'utf8') } catch { console.warn(`skip missing ${file}`); continue }
  for (const m of xml.matchAll(/<channel id="([^"]*)"[\s\S]*?<\/channel>/g)) if (!channels.has(m[1])) channels.set(m[1], m[0])
  for (const m of xml.matchAll(/<programme [\s\S]*?<\/programme>/g)) programmes.push(m[0])
  console.log(`${file}: total channels ${channels.size}, programmes ${programmes.length}`)
}
const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
await writeFile(out, [
  '<?xml version="1.0" encoding="UTF-8" ?>',
  `<tv date="${date} +0000" generator-info-name="anclist/tv-guide">`,
  ...channels.values(), ...programmes, '</tv>', ''
].join('\n'))
console.log(`wrote ${out}: ${channels.size} channels, ${programmes.length} programmes`)
