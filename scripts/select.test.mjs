// Run with: node --test scripts/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normName } from './sources.mjs'
import { feedOf, tzEquivalent, geoPlausible, availability, clusterCandidates, rankPair, pickPair } from './select.mjs'

const lineupOf = c => (c === 'CA' ? 'US' : c)
const lineupKey = (country, name) => { const n = normName(name); return n ? `${lineupOf(country)}|${n}` : null }
const ctxBase = {
  deadAfter: 3, viewerCountry: 'CA', channelCountry: 'US', mainFeed: 'East',
  prio: site => ['high.site', 'low.site'].indexOf(site),
}
const stream = o => ({ kind: 'stream', source: 'iptv-org', url: 'http://a', labels: [], quality: 720, ...o })
const guide = o => ({ kind: 'guide', source: 'iptv-org', site: 'high.site', siteId: '1', proof: 1, ...o })

test('feedOf: iptv-org stream feed wins', () => {
  assert.deepEqual(feedOf({ feed: 'West', tvgId: 'ABC.us@East' }, 'SD'), { feed: 'West', explicit: true })
})
test('feedOf: tvg-id suffix next', () => {
  assert.deepEqual(feedOf({ tvgId: 'ABC.us@East' }, 'SD'), { feed: 'East', explicit: true })
})
test('feedOf: main feed default, never another candidate\'s feed', () => {
  const iptvStream = { feed: 'West' }
  const freetv = { tvgId: 'ABC.us' }
  assert.equal(feedOf(iptvStream, 'East').feed, 'West')
  assert.deepEqual(feedOf(freetv, 'East'), { feed: 'East', explicit: false })
})

test('tzEquivalent: New York matches Toronto, Los Angeles does not', () => {
  assert.equal(tzEquivalent('America/New_York', 'America/Toronto'), true)
  assert.equal(tzEquivalent('America/Los_Angeles', 'America/Toronto'), false)
  assert.equal(tzEquivalent('Not/AZone', 'America/Toronto'), false)
})

test('geo: Canadian geo-blocked stream is not penalised for a Canadian viewer', () => {
  const geo = stream({ labels: ['Geo-blocked'], quality: 1080 })
  const clean = stream({ url: 'http://b', quality: 720 })
  assert.equal(geoPlausible(geo, 'CA', 'CA'), true)
  const ctx = { ...ctxBase, channelCountry: 'CA' }
  const { stream: s } = pickPair({ streams: [clean, geo], guides: [] }, ctx)
  assert.equal(s, geo) // quality decides
})
test('geo: US geo-blocked 1080p loses to clean 720p for a Canadian viewer', () => {
  const geo = stream({ labels: ['Geo-blocked'], quality: 1080 })
  const clean = stream({ url: 'http://b', quality: 720 })
  assert.equal(availability(geo, 'US', 'CA'), 0)
  assert.equal(pickPair({ streams: [geo, clean], guides: [] }, ctxBase).stream, clean)
})
test('geo: flagged extra source uses its own country, not the channel\'s', () => {
  const us = stream({ source: 'samsung-us', url: 'http://us', labels: ['Geo-blocked'], geoCountry: 'US', quality: 1080 })
  const ca = stream({ source: 'samsung-ca', url: 'http://ca', labels: ['Geo-blocked'], geoCountry: 'CA', quality: 0 })
  assert.equal(geoPlausible(us, 'CA', 'CA'), false)
  assert.equal(geoPlausible(ca, 'US', 'CA'), true)
  // a US-only channel keeps its stream, ranked last rather than dropped
  assert.equal(pickPair({ streams: [us], guides: [] }, { ...ctxBase, channelCountry: 'CA' }).stream, us)
})
test('availability: Not 24/7 sits between clean and geo-blocked', () => {
  assert.equal(availability(stream({ labels: ['Not 24/7'] }), 'US', 'CA'), 1)
  assert.equal(availability(stream(), 'US', 'CA'), 2)
})

function fixture() {
  const channels = [
    { id: 'ABC.us', name: 'ABC', country: 'US' },
    { id: 'Gone.us', name: 'Gone', country: 'FR' }, // in the full list but not selected
  ]
  const selected = new Map([['ABC.us', channels[0]]])
  return { selected, allChannelIds: new Set(channels.map(c => c.id)), lineupKey, countries: new Set(['US', 'CA']) }
}

test('cluster: feed-qualified tvg-id joins the iptv-org channel', () => {
  const { clusters } = clusterCandidates({
    ...fixture(),
    extra: [stream({ source: 'freetv', tvgId: 'ABC.us@West', name: 'Whatever', country: 'US' })],
  })
  assert.deepEqual([...clusters.keys()], ['ABC.us'])
})
test('cluster: Samsung US and CA copies of one channel merge', () => {
  const { clusters } = clusterCandidates({
    ...fixture(),
    extra: [
      stream({ source: 'samsung-us', tvgId: 'US1', name: 'Bob Ross', country: 'US', url: 'http://us' }),
      stream({ source: 'samsung-ca', tvgId: 'CA1', name: 'Bob Ross HD', country: 'CA', url: 'http://ca' }),
    ],
  })
  assert.equal(clusters.size, 1)
  assert.equal([...clusters.values()][0].streams.length, 2)
})
test('cluster: variants with the same source tvg-id stay one channel', () => {
  const { clusters } = clusterCandidates({
    ...fixture(),
    extra: [
      stream({ source: 'tdt', tvgId: 'E3.TV', name: 'Esport3 GEO', country: 'US', url: 'http://1' }),
      stream({ source: 'tdt', tvgId: 'E3.TV', name: 'Esport3 GEO CAT', country: 'US', url: 'http://2' }),
    ],
  })
  assert.equal(clusters.size, 1)
  assert.equal([...clusters.values()][0].streams.length, 2)
})
test('cluster: stale id vs out-of-scope id', () => {
  const { staleIds } = clusterCandidates({
    ...fixture(),
    extra: [
      stream({ source: 'freetv', tvgId: 'Renamed.us', name: 'Renamed', country: 'US' }),
      stream({ source: 'freetv', tvgId: 'Seven.au', name: 'Seven', country: 'AU' }), // not one of our countries
      stream({ source: 'freetv', tvgId: 'Gone.us', name: 'Gone', country: 'FR' }),
      stream({ source: 'samsung-us', tvgId: 'US123ABC', name: 'Opaque', country: 'US' }),
      stream({ source: 'tdt', tvgId: 'La2.TV', name: 'La 2', country: 'ES' }),
    ],
  })
  assert.deepEqual(staleIds.map(x => x.tvgId), ['Renamed.us'])
})
test('cluster + pick: swapping source order gives the same result', () => {
  const extra = [
    stream({ source: 'samsung-us', tvgId: 'US1', name: 'Bob Ross', country: 'US', url: 'http://us', sourceCountry: 'US' }),
    stream({ source: 'samsung-ca', tvgId: 'CA1', name: 'Bob Ross', country: 'CA', url: 'http://ca', sourceCountry: 'CA' }),
  ]
  const run = list => {
    const { clusters } = clusterCandidates({ ...fixture(), extra: list })
    return [...clusters.values()].map(cl => [cl.id, pickPair(cl, { ...ctxBase, mainFeed: null }).stream.url])
  }
  assert.deepEqual(run(extra), run([...extra].reverse()))
})

test('rank: feed match beats site priority', () => {
  const s = stream({ feed: 'East' })
  const west = guide({ site: 'high.site', feed: 'West' })
  const east = guide({ site: 'low.site', feed: 'East', siteId: '2' })
  assert.equal(pickPair({ streams: [s], guides: [west, east] }, ctxBase).guide, east)
})
test('rank: proven extra EPG beats an unproven listing', () => {
  const s = stream({ feed: 'East' })
  const listed = guide({ site: 'high.site', proof: 1 })
  const epg = guide({ source: 'tdt', site: 'tdt', external: true, origId: 'X.TV', proof: 2 })
  assert.equal(pickPair({ streams: [s], guides: [listed, epg] }, ctxBase).guide, epg)
})
test('rank: dead Free-TV stream loses to a live iptv-org stream', () => {
  const free = stream({ source: 'freetv', url: 'http://free', preferStream: true, streak: 3 })
  const iptv = stream({ url: 'http://iptv', streak: 0 })
  assert.equal(pickPair({ streams: [free, iptv], guides: [] }, ctxBase).stream, iptv)
})
test('rank: CA source wins the tie over US source', () => {
  const us = stream({ source: 'samsung-us', url: 'http://us', sourceCountry: 'US' })
  const ca = stream({ source: 'samsung-ca', url: 'http://ca', sourceCountry: 'CA' })
  assert.equal(pickPair({ streams: [us, ca], guides: [] }, ctxBase).stream, ca)
})
test('rank: a guide that failed last run ranks below an unknown one', () => {
  const s = stream({ feed: 'East' })
  const failed = guide({ site: 'high.site', proof: 0 })
  const unknown = guide({ site: 'low.site', siteId: '2', proof: 1 })
  const { guide: g, guides } = pickPair({ streams: [s], guides: [failed, unknown] }, ctxBase)
  assert.equal(g, unknown)
  assert.deepEqual(guides, [unknown, failed])
})
test('rank: viewer-timezone feed breaks ties', () => {
  const ctx = { ...ctxBase, feedMatchesViewerTz: f => f === 'East' }
  const east = stream({ url: 'http://e', feed: 'East' })
  const west = stream({ url: 'http://w', feed: 'West' })
  assert.deepEqual(rankPair(east, null, ctx)[6], 1)
  assert.equal(pickPair({ streams: [west, east], guides: [] }, ctx).stream, east)
})
