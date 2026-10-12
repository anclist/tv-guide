// Pure selection logic: candidate feeds, viewer geo/timezone rules, clustering and pair ranking.
// Candidates are plain objects built by build-lists.mjs:
//   stream: { kind: 'stream', source, url, feed?, tvgId?, labels, quality, userAgent?, referrer?,
//             sourceCountry?, preferStream?, streak? }
//   guide:  { kind: 'guide', source, site, siteId?, lang?, feed?, origId?, external?, proof }

// Feed of one candidate: its own iptv-org feed, then the tvg-id after "@", then the channel's main feed.
export function feedOf({ feed, tvgId }, channelMainFeed) {
  if (feed) return { feed, explicit: true }
  const at = tvgId?.indexOf('@') ?? -1
  if (at > 0 && at < tvgId.length - 1) return { feed: tvgId.slice(at + 1), explicit: true }
  return { feed: channelMainFeed ?? null, explicit: false }
}

// Two zones are equivalent when their UTC offsets match in January and in July.
const offsetCache = new Map()
function offsetPair(tz) {
  if (!offsetCache.has(tz)) {
    let v = null
    try {
      const y = new Date().getUTCFullYear()
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      v = [0, 6].map(m => f.formatToParts(Date.UTC(y, m, 15)).find(p => p.type === 'timeZoneName').value).join('|')
    } catch {} // unknown zone names never match
    offsetCache.set(tz, v)
  }
  return offsetCache.get(tz)
}
export const tzEquivalent = (a, b) => { const x = offsetPair(a); return !!x && x === offsetPair(b) }

// iptv-org labels are relative to the channel's own country: "Geo-blocked" usually plays only there.
export const geoPlausible = (stream, channelCountry, viewerCountry) =>
  !stream.labels?.includes('Geo-blocked') || channelCountry === viewerCountry

// 0 = geo-blocked for the viewer, 1 = not 24/7, 2 = clean.
export function availability(stream, channelCountry, viewerCountry) {
  if (!geoPlausible(stream, channelCountry, viewerCountry)) return 0
  return stream.labels?.includes('Not 24/7') ? 1 : 2
}

// Shaped like an iptv-org id ("Name.cc", lowercase country code, optional "@feed").
const IPTV_ID = /^[A-Za-z0-9][^.@\s]*\.[a-z]{2}(@.+)?$/
export const baseIdOf = tvgId => tvgId?.split('@')[0] || ''

// Groups candidates into channels. iptv-org candidates carry `channel`; extra candidates carry
// `tvgId`, `name` and `country`. An extra candidate joins an iptv-org channel by base id, else the
// cluster of an earlier entry with the same source and tvg-id (variants like "X GEO"), else by
// lineup name key, else an extra-only cluster keyed by lineup name key (so the same FAST channel
// from two lineups merges). Extra-only clusters outside `countries` are dropped.
export function clusterCandidates({ selected, allChannelIds, lineupKey, countries, iptv = [], extra = [] }) {
  const iptvByKey = new Map()
  for (const c of selected.values()) {
    for (const n of [c.name, ...(c.alt_names ?? [])]) {
      const k = lineupKey(c.country, n)
      if (k && !iptvByKey.has(k)) iptvByKey.set(k, c.id)
    }
  }
  const clusters = new Map()
  const clusterFor = (id, init) => {
    if (!clusters.has(id)) clusters.set(id, { id, streams: [], guides: [], ...init })
    return clusters.get(id)
  }
  const add = (cl, cand) => (cand.kind === 'guide' ? cl.guides : cl.streams).push(cand)

  for (const cand of iptv) add(clusterFor(cand.channel, { channel: selected.get(cand.channel) }), cand)

  const staleIds = []
  const nameMatches = []
  const staleSeen = new Set()
  const bySourceId = new Map() // "<source>|<tvgId>" -> cluster id
  for (const cand of extra) {
    const baseId = baseIdOf(cand.tvgId)
    // Only ids from the configured countries are worth reconciling; the rest are out of scope anyway.
    const cc = baseId.slice(baseId.lastIndexOf('.') + 1).toUpperCase()
    if (baseId && IPTV_ID.test(cand.tvgId) && countries.has(cc) && !allChannelIds.has(baseId)) {
      const k = `${cand.source}|${cand.tvgId}`
      if (!staleSeen.has(k)) { staleSeen.add(k); staleIds.push({ source: cand.source, tvgId: cand.tvgId, name: cand.name }) }
    }
    const key = lineupKey(cand.country, cand.name)
    const srcId = cand.tvgId ? `${cand.source}|${cand.tvgId}` : null
    let id = selected.has(baseId) ? baseId : srcId && bySourceId.get(srcId)
    if (!id && key && iptvByKey.has(key)) {
      id = iptvByKey.get(key)
      if (cand.kind === 'stream') nameMatches.push(`${cand.source} "${cand.name}" -> ${id}`)
    }
    if (!id && key && countries.has(cand.country)) id = `x:${key}`
    if (!id) continue
    if (srcId && !bySourceId.has(srcId)) bySourceId.set(srcId, id)
    const cl = clusters.get(id) ?? clusterFor(id, selected.has(id) ? { channel: selected.get(id) } : { channel: null, key })
    add(cl, cl.channel ? { ...cand, channel: id } : cand)
  }
  // Clusters with no stream can't be played; iptv-org guides only matter for streamed channels.
  for (const [id, cl] of clusters) if (!cl.streams.length) clusters.delete(id)
  return { clusters, staleIds, nameMatches }
}

// Tier tuple, compared element by element (higher wins). See design.md §3 and the spec.
// ctx: { deadAfter, viewerCountry, channelCountry, mainFeed, feedMatchesViewerTz(feed), prio(site) }
export function rankPair(s, g, ctx) {
  const sFeed = s.feed ?? ctx.mainFeed ?? null
  const gFeed = g ? (g.feed ?? ctx.mainFeed ?? null) : null
  return [
    (s.streak ?? 0) < ctx.deadAfter ? 1 : 0,
    availability(s, ctx.channelCountry, ctx.viewerCountry),
    g ? 1 : 0,
    g && gFeed === sFeed ? 1 : 0,
    g ? g.proof : 0,
    (s.sourceCountry && s.sourceCountry === ctx.viewerCountry ? 2 : 0) + (s.preferStream ? 1 : 0),
    ctx.feedMatchesViewerTz?.(sFeed) ? 1 : 0,
    g ? -ctx.prio(g.site) : -Infinity,
    s.userAgent || s.referrer ? 0 : 1,
    s.quality ?? 0,
  ]
}

export function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

// Stable last resort so results never depend on input order.
const idOf = (s, g) => `${s.source}|${s.url}|${g ? `${g.source}|${g.site}|${g.siteId ?? g.origId ?? ''}` : ''}`

// Best (stream, guide) pair of a cluster, plus every guide ranked for the chosen stream
// (used for the fallback grab).
export function pickPair(cluster, ctx) {
  let best = null
  for (const s of cluster.streams) {
    for (const g of [...cluster.guides, null]) {
      const rank = rankPair(s, g, ctx)
      const id = idOf(s, g)
      if (!best || compareRank(rank, best.rank) > 0 || (compareRank(rank, best.rank) === 0 && id < best.id)) {
        best = { stream: s, guide: g, rank, id }
      }
    }
  }
  const guides = cluster.guides
    .map(g => ({ g, rank: rankPair(best.stream, g, ctx), id: idOf(best.stream, g) }))
    .sort((a, b) => compareRank(b.rank, a.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(x => x.g)
  return { stream: best.stream, guide: best.guide, guides }
}
