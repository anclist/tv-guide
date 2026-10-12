## Context

See proposal.md for the motivation. Constraints that shape the approach:

- The whole pipeline is one GitHub Actions job: `build-lists.mjs` → `iptv-org/epg` grab in batches → `merge-guides.mjs` → `check-guide.mjs` → Pages deploy. Runs take about 15 minutes against a 180-minute limit.
- The runner is a US datacenter host. The viewer is in Canada (Eastern time). The runner cannot tell whether a stream plays in Canada.
- The only state that survives from one run to the next is the published Pages site. There is no repo commit and no cache. Pages deploys only on success.
- There is no test suite today, and no npm dependencies in this repo: scripts use only Node 22 built-ins.
- Extra-source EPGs are downloaded and parsed during selection, so whether they have programmes is known up front. iptv-org guides are only known after the grab.

## Goals / Non-Goals

**Goals:**
- Choose streams and guides by evidence: probe streaks, last-run guide results, and EPG data already in hand. Fall back to static heuristics only when there is no evidence.
- Move ranking into pure functions that can be unit-tested with `node:test`.
- Keep the published `tvg-id` scheme and the playlist and guide URLs unchanged.

**Non-Goals:**
- Probing from Canada (self-hosted runner or a home script). It may come later; `health.json` could accept a viewer-side overlay.
- Dropping channels automatically. Probes only rank.
- Validating stream content beyond the playlist response (segment fetch, bitrate).
- Changing which channels are selected (countries, categories, languages).

## Decisions

### 1. Pipeline shape: pool, then pick

```
 gather ----> cluster ----> validate ----> rank pairs ----> emit
 (iptv-org    (base id,     (probe URLs,   (tier tuple,     playlists, batches,
  + extras)    name key)     read health)   per cluster)     state/*.json
                                                               |
 grab batches --> [fallback grab] --> merge --> record health --> check-guide --> deploy
                                                 (public/health.json)
```

`build-lists.mjs` keeps its job of producing playlists and batches, but steps 2–4b are replaced by: build candidate lists, cluster, probe, rank. A candidate is either `{kind:'stream', source, url, feed, feedExplicit, labels, quality, ua, referrer, country}` or `{kind:'guide', source, site, siteId, lang, feed, xmltvId, proven}`.

Alternative considered: keep the current passes and patch each one (the outside review's fixes). Rejected, because first-wins order is the root problem, and patches cannot express "prefer the proven guide" or "prefer the live stream".

### 2. Clustering key

The cluster id is the iptv-org channel id. An extra candidate goes to:
- `selected.get(baseId)`, where `baseId = tvgId.split('@')[0]`; otherwise
- `iptvByLineupKey(country, name)`; otherwise
- an extra-only cluster keyed by lineup name key. That way `samsung-us` and `samsung-ca` duplicates merge into one cluster, and ranking picks between them.

Extra-only clusters keep today's `<source>:<origId>` tvg-id, taken from the chosen guide's source when there is one, and from the chosen stream's source otherwise. Stale-id detection works against `allChannelIds` (every channel, not just selected ones), and only reports ids whose country suffix is in `countries`, as the spec describes.

### 3. Ranking as a lexicographic tuple

`rankPair(stream, guide, ctx)` returns an array that is compared element by element, highest wins. The tiers are listed in the spec.

| Tier | Value |
|---|---|
| alive | `streak < deadAfter ? 1 : 0` |
| availability | geo-implausible `0`, `Not 24/7` `1`, otherwise `2` |
| hasGuide | `0`/`1` |
| feedMatch | guide feed equals stream feed; an extra EPG with unknown feed counts as matching the main feed |
| guideProof | failed last run `0`, unknown `1`, proven `2` |
| sourcePref | `(sourceCountry===viewerCountry)*2 + preferStream` |
| tzMatch | `0`/`1` |
| `-sitePrio` | `noUaRef` | `quality` | tiebreaks |

Pairs are enumerated per cluster as streams × (guides + none). The worst observed case is a few dozen candidates, so this costs nothing.

Alternative considered: a weighted numeric score, as today. Rejected, because the weights end up silently overriding the intended priority. That's exactly the `prio*10 + feedMismatch` bug.

### 4. Geo and timezone rules

- **Geo-implausible** means `labels` includes `Geo-blocked` and the country it is blocked to is not `viewerCountry`. For iptv-org streams that country is the channel's. Extra sources flagged `geoBlocked` (Samsung, Pluto: they return 403 outside their region) give their streams the label with `geoCountry` set to the source's own country. That matters in a merged channel, where a Samsung US copy must not inherit CA. Unflagged extra sources carry no labels, so they count as plausible. The US runner cannot detect these blocks, because they return 200 there.
- **Timezone equivalence**: compare `Intl.DateTimeFormat(..., {timeZone, timeZoneName:'longOffset'})` for Jan 15 and Jul 15 of the current year. The feed matches when any of its timezones equals the viewer's offset pair. Results are cached per zone. The noisy `timezones` data only affects tier 7.

### 5. Probe

- `GET` each candidate URL with `redirect:'follow'`, the candidate's UA and referrer, an `AbortSignal.timeout(probe.timeoutMs)` (default 8000), and up to `probe.concurrency` requests at once (default 32). Only the first chunk of the body is read.
- **OK**: a 2xx response whose first bytes contain `#EXTM3U`, or whose content-type is a video/MPEG-TS type.
- **Geo-related**: 401, 403 or 451. The streak is left unchanged.
- **Failure**: anything else.
- Only candidates in selected clusters are probed. That's about 5–6k URLs, roughly 3–4 minutes at 32 concurrent requests.
- **Health key**: the URL with the query string and fragment removed, so tokenised URLs keep their history.

Alternative considered: `HEAD` requests. Rejected, because many HLS origins reject or mishandle `HEAD`.

### 6. `health.json` format and feedback loop

```json
{
  "version": 1,
  "generatedAt": "2026-10-12T08:20:00Z",
  "streams": { "<url-no-query>": { "streak": 0, "lastOk": "2026-10-12", "seen": "2026-10-12" } },
  "guides":  { "<site>|<site_id>": { "programmes": 42, "emptyStreak": 0, "lastOk": "2026-10-12", "seen": "2026-10-12" } },
  "summary": { "channels": 3512, "guided": 1777, "withGuide": 1594, "staleIds": 3, "ambiguousFeeds": 40, "allDead": 12, "fallbackTried": 80, "fallbackUsed": 61 }
}
```

The loop:
- **Read**: `build-lists.mjs` fetches `${publicBaseUrl}/health.json`. If it fails it logs a warning and uses an empty record.
- **Hand-off**: `build-lists.mjs` writes `state/health.prev.json`, `state/probes.json` (key → ok/fail/geo) and `state/guide-map.json` (tvgId → ranked guide candidates with site/site_id; the first one is the one being grabbed).
- **Write**: a new `scripts/record-health.mjs` runs after the merge. It counts programmes per `channel=` in the merged guide, maps them back through `guide-map.json`, applies the probe results, prunes entries not seen for 14 days, and writes `public/health.json`.

A guide counts as proven when `programmes > 0` on the last run, and as failed when `emptyStreak >= 1`. A single empty grab is enough to demote a guide, because the cost is low (it only reorders guide choice) and the fallback pass retries it.

Alternative considered: storing state with `actions/cache` or by committing to the repo. Rejected. The cache has eviction and is scoped per branch. Committing creates a bot commit every day. Pages is already the deploy target and stays consistent with the playlist that was served.

### 7. Fallback grab

`scripts/fallback-batches.mjs` reads `state/guide-map.json` and the first-pass guide files. For every tvgId with zero programmes, it takes the next guide candidate on a different site that isn't excluded, and writes `batches/fallback-NN.channels.xml` files with the same `xmltv_id`. The workflow runs a second grab loop over those files into `guides/fallback-NN.xml` before the merge. `merge-guides.mjs` already keeps the first `<channel>` it sees for an id and appends programmes, so a fallback file only adds programmes for ids that had none.

The fallback channel is also recorded in `guide-map.json` as used. Next run, the first-pass guide is demoted (it failed) and the fallback is proven, so ranking picks it as primary on its own. No extra state is needed.

### 8. Code layout

- `scripts/select.mjs`: pure functions `clusterCandidates`, `rankPair`, `pickPair`, `feedOf`, `geoPlausible`, `tzEquivalent`. Covered by `scripts/select.test.mjs` (`node --test scripts/`).
- `scripts/probe.mjs`: `probeAll(urls, opts)` → Map of results.
- `scripts/health.mjs`: `loadHealth(url)`, `keyOfUrl`, `nextHealth(prev, probes, guideResults)`.
- `scripts/record-health.mjs` and `scripts/fallback-batches.mjs`: thin CLIs.
- `scripts/build-lists.mjs`: orchestration and output writing. It should shrink.

## Risks / Trade-offs

- [A US-only stream passes the probe but fails in Canada, and it has no `Geo-blocked` label] → Can't be detected from the runner. This is accepted. The way out later is a viewer-side overlay (non-goal).
- [Probes add runtime, and some origins rate-limit datacenter IPs] → Concurrency cap and timeout are configurable. Rate-limit responses (429) count as failures but need 3 consecutive runs. Watch the all-dead count.
- [A bad day (upstream outage) marks many guides as failed] → The demotion only reorders guide choice, and the fallback grab plus the next run restore them. The summary deltas make a mass flip visible.
- [`health.json` is lost if Pages is reset or the URL changes] → Cold start behaviour is defined and safe.
- [The fallback grab doubles runtime for bad sites] → It is limited to channels with empty results (about 180 today) and can be turned off with `fallbackGrab`.
- [Clustering by name key could merge two different channels with the same name in a shared lineup] → The same risk exists today. The name-match log is kept.
- [Output churn: the first run after deploy swaps many streams] → It is expected. TiviMate keys on `tvg-id`, which keeps its scheme, so favourites survive unless a channel moves from an iptv-org id to an extra id.

## Migration Plan

1. Merge with `fallbackGrab: true`. The first run is a cold start: ranking uses tiers without health evidence, and `health.json` gets published.
2. The second and third runs build up evidence. Compare the coverage numbers in the summary against the 2026-10-11 baseline (1594/1777 channels with programmes).
3. Rollback: revert the commit. The stale `health.json` on Pages is ignored by the old code and disappears on the next deploy.

## Open Questions

- The exact probe timeout and concurrency, and the 14-day prune age. Tune after the first runs; this doesn't affect specs or tasks.
