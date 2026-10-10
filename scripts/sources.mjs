// Helpers for extra M3U/XMLTV sources (Free-TV, TDTChannels, Pluto TV, Samsung TV Plus).
import { gunzipSync } from 'node:zlib'

export async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // gzip magic bytes, regardless of extension or content-encoding
  return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8')
}

// Parses an M3U playlist into { name, tvgId, logo, group, country, url, userAgent, referrer }.
export function parseM3u(text) {
  const out = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF')) {
      const attrs = {}
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2]
      const comma = line.lastIndexOf('",') === -1 ? line.indexOf(',') : line.lastIndexOf('",') + 1
      cur = {
        name: line.slice(comma + 1).trim() || attrs['tvg-name'] || '',
        tvgId: attrs['tvg-id'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
        country: (attrs['tvg-country'] || '').toUpperCase(),
      }
    } else if (cur && line.startsWith('#EXTVLCOPT:')) {
      const [k, ...v] = line.slice(11).split('=')
      if (k === 'http-user-agent') cur.userAgent = v.join('=')
      if (k === 'http-referrer') cur.referrer = v.join('=')
    } else if (cur && line && !line.startsWith('#')) {
      out.push({ ...cur, url: line })
      cur = null
    }
  }
  return out
}

// Free-TV markers: Ⓢ not HD, Ⓖ geo-blocked, Ⓨ YouTube.
export const cleanName = name => name.replace(/[ⓈⒼⓎ]/g, '').replace(/\s+/g, ' ').trim()

// Comparison key for a channel name: no accents, case, punctuation, brackets or quality suffix.
export function normName(name) {
  return cleanName(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(fhd|uhd|hd|sd|4k|1080p|720p|480p)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
}

// Maps a source's group name (English or Spanish) to an iptv-org category id.
const CATEGORY_RULES = [
  [/news|noticia|informativ|opinion/, 'news'],
  [/sport|deport/, 'sports'],
  [/kid|infantil|niño|nino|anime|animation|family|familia/, 'kids'],
  [/movie|cine|pelicula|film|western/, 'movies'],
  [/music|musica|musical/, 'music'],
  [/comed/, 'comedy'],
  [/documental|history|science|cultura|nature|animals/, 'documentary'],
  [/religio/, 'religious'],
  [/food|cocina|home|travel|viaje/, 'lifestyle'],
  [/series|serie|drama|classic|crime|crimen|policia|telenovela|misterio|sci-fi/, 'series'],
  [/reality|entertain|entreten|game show|daytime/, 'entertainment'],
]
export function categoryFor(group) {
  const g = group.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  for (const [re, cat] of CATEGORY_RULES) if (re.test(g)) return cat
  return 'general'
}

// XMLTV time "20261009235000 +0000" -> epoch ms.
export function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})/.exec(s ?? '')
  if (!m) return NaN
  const [, y, mo, d, h, mi, se, sign, oh, om] = m
  const off = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60000
  return Date.UTC(+y, mo - 1, +d, +h, +mi, +se) - off
}

// Splits an XMLTV document into channels (id -> xml) and programmes ([{ channel, start, stop, xml }]).
export function parseXmltv(xml) {
  const channels = new Map()
  for (const m of xml.matchAll(/<channel id="([^"]*)"[\s\S]*?<\/channel>/g)) channels.set(m[1], m[0])
  const programmes = []
  for (const m of xml.matchAll(/<programme ([^>]*)>[\s\S]*?<\/programme>/g)) {
    const attr = k => (m[1].match(new RegExp(`${k}="([^"]*)"`)) ?? [])[1]
    programmes.push({ channel: attr('channel'), start: xmltvTime(attr('start')), stop: xmltvTime(attr('stop')), xml: m[0] })
  }
  return { channels, programmes }
}
