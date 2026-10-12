// Run with: node --test scripts/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyOfUrl, nextHealth, guideProof, streakOf, loadHealth, emptyHealth } from './health.mjs'

const now = new Date('2026-10-12T08:00:00Z')

test('keyOfUrl strips query and fragment', () => {
  assert.equal(keyOfUrl('https://x.tv/live.m3u8?token=abc#t'), 'https://x.tv/live.m3u8')
  assert.equal(keyOfUrl('https://x.tv/live.m3u8'), 'https://x.tv/live.m3u8')
})

test('stream streak: fail increments, geo leaves it, ok resets', () => {
  let h = emptyHealth()
  h = nextHealth(h, { a: 'fail', b: 'geo' }, {}, { now })
  assert.equal(h.streams.a.streak, 1)
  assert.equal(h.streams.b.streak, 0)
  h = nextHealth(h, { a: 'fail', b: 'geo' }, {}, { now })
  assert.equal(h.streams.a.streak, 2)
  assert.equal(h.streams.b.streak, 0)
  h = nextHealth(h, { a: 'ok' }, {}, { now })
  assert.deepEqual(h.streams.a, { streak: 0, lastOk: '2026-10-12', seen: '2026-10-12' })
  assert.equal(streakOf(h, 'a?x=1'), 0)
})

test('guide results: proven, then empty, then demoted', () => {
  let h = nextHealth(emptyHealth(), {}, { 'mi.tv|1': 42 }, { now })
  assert.equal(guideProof(h, 'mi.tv', '1'), 2)
  h = nextHealth(h, {}, { 'mi.tv|1': 0 }, { now })
  assert.equal(h.guides['mi.tv|1'].emptyStreak, 1)
  assert.equal(h.guides['mi.tv|1'].lastOk, '2026-10-12')
  assert.equal(guideProof(h, 'mi.tv', '1'), 0)
  assert.equal(guideProof(h, 'mi.tv', 'unknown'), 1)
})

test('entries not seen for 14 days are pruned, recent ones kept', () => {
  const prev = {
    ...emptyHealth(),
    streams: { old: { streak: 2, seen: '2026-09-20' }, recent: { streak: 1, seen: '2026-10-05' } },
    guides: { 'a|1': { programmes: 3, emptyStreak: 0, seen: '2026-09-01' } },
  }
  const h = nextHealth(prev, {}, {}, { now })
  assert.deepEqual(Object.keys(h.streams), ['recent'])
  assert.deepEqual(h.guides, {})
})

test('loadHealth falls back to an empty record', async () => {
  const h = await loadHealth('https://anclist.github.io/tv-guide/does-not-exist.json')
  assert.deepEqual(h, emptyHealth())
})
