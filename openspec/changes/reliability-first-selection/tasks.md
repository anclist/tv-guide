## 1. Config and test scaffold

- [x] 1.1 Add `viewerCountry: "CA"`, `viewerTimezone: "America/Toronto"`, `probe: {timeoutMs: 8000, concurrency: 32}`, `deadAfter: 3` and `fallbackGrab: true` to `config.json`, and document them in `README.md`. Verify: `node -e "require('./config.json')"` parses.
- [x] 1.2 Create `scripts/select.test.mjs` with a placeholder test. Verify: `node --test scripts/` runs and passes.

## 2. Pure selection logic (`scripts/select.mjs`)

- [x] 2.1 Implement `feedOf(candidate, mainFeed)`: iptv-org stream feed, then `tvg-id` after `@`, then the main feed. It also returns whether the feed was explicit. Verify: tests cover all three sources, and confirm no feed is inherited from another candidate.
- [x] 2.2 Implement `tzEquivalent(a, b)` using Jan/Jul offsets, with a cache. Verify: tests show `America/New_York` ≡ `America/Toronto`, and `America/Los_Angeles` ≢ `America/Toronto`.
- [x] 2.3 Implement `geoPlausible(stream, channelCountry, viewerCountry)` and the availability tier, covering `Geo-blocked` and `Not 24/7`. Verify: tests match the two geo scenarios in the spec.
- [x] 2.4 Implement `clusterCandidates`: split the base id off `@`, fall back to the lineup name key, merge extra-only clusters by lineup key, and collect stale ids checked against `allChannelIds`. Verify: tests cover the feed-qualified id joining, Samsung US/CA merging into one, the stale id vs out-of-scope id cases, and that swapping source order gives identical clusters.
- [x] 2.5 Implement `rankPair` and `pickPair` with the tier tuple from design §3. Verify: tests cover feed match beating site priority, a proven extra EPG beating an unproven listing, a dead Free-TV stream losing to a live iptv-org one, and a CA-source tiebreak.

## 3. Probe and health modules

- [x] 3.1 Implement `scripts/probe.mjs` `probeAll` (GET, follow redirects, read the first chunk, ok/geo/fail classification, concurrency cap, timeout). Verify: run it against a small hand-picked URL list (one known-good, one 404, one bogus host) and check the classifications.
- [x] 3.2 Implement `scripts/health.mjs`: `keyOfUrl` (strips query and fragment), `loadHealth` (fetch, with an empty fallback and a warning), and `nextHealth` (streak update where geo leaves it unchanged and ok resets it, guide counts and empty streak, 14-day prune). Verify: unit tests for the streak transitions and pruning, and `loadHealth` against a 404 URL returns an empty record.

## 4. Rewire `build-lists.mjs`

- [x] 4.1 Replace steps 2–4b with: gather candidates from iptv-org streams/guides and all extras (including extra EPG ids with programmes in the window as proven guides), then cluster, probe, and `pickPair` per cluster. Keep the existing entry/group/logo building and the `tvg-id` scheme. Verify: `node scripts/build-lists.mjs <scratch>/out` completes and the playlists contain no duplicate `tvg-id`.
- [x] 4.2 Make the choice of which extra-source EPG to trim and prefix follow the chosen guide (replacing `keptGuideIds`). Verify: every `<source>:` tvg-id in `playlist-guided.m3u` has a `<channel>` in the matching `guides/extra-<source>.xml`.
- [x] 4.3 Write `state/health.prev.json`, `state/probes.json` and `state/guide-map.json` (ranked guide candidates per grabbed tvgId). Add `state/` to `.gitignore`. Verify: the files exist after a local run, and `guide-map.json` lists the batched site/site_id as each entry's first candidate.
- [x] 4.4 Log per-source counts, stale ids, ambiguous feeds and all-dead channels, and write them to `state/diagnostics.json`. Verify: the local run log shows the lists and the JSON matches.

## 5. Post-grab scripts

- [x] 5.1 Implement `scripts/fallback-batches.mjs`: read `guide-map.json` and the first-pass guides, and emit `batches/fallback-NN.channels.xml` with the next candidate on a different site for each zero-programme tvgId. Mark the chosen fallback in `guide-map.json`. Verify: run it on local first-pass output and check that the fallback channels all have empty first-pass results and a different site.
- [x] 5.2 Implement `scripts/record-health.mjs`: count programmes per channel in the merged guide, map them through `guide-map.json`, apply `probes.json`, add the summary counts, and write `public/health.json`. Verify: it produces valid JSON matching the design §6 format, and a channel with programmes has `programmes > 0` on its site|site_id.
- [x] 5.3 Extend `scripts/check-guide.mjs` to read `state/diagnostics.json` and the previous `summary` from `state/health.prev.json`, and append sections for stale ids, ambiguous feeds, all-dead channels and fallback use, each with its change since the last run. Verify: running it locally prints the new sections, and deltas show `n/a` on a cold start.

## 6. Workflow

- [x] 6.1 In `.github/workflows/build.yml`, add a fallback grab loop (skipped when `fallbackGrab` is false or there are no fallback batches), followed by `record-health.mjs` after the merge. Make sure `public/health.json` is part of the Pages artifact. Verify: a `workflow_dispatch` run succeeds and `${publicBaseUrl}/health.json` is served.
- [x] 6.2 Add `health.json` to the generated `index.html` link list. Verify: the deployed index shows the link.

## 7. Rollout verification

- [x] 7.1 Cold-start run: confirm the build completes, no stream is marked dead, and the coverage summary is at or above the 2026-10-11 baseline (1594 channels with programmes). Record the numbers.
- [ ] 7.2 After the third daily run: confirm streaks are building up, fallback-used is above 0, the samsung-ca duplicate count has dropped compared to the baseline 237, and coverage has improved. Write down any tuning needed for the probe timeout, concurrency or prune age.

## 8. Fixes from the first run

- [x] 8.1 Make `record-health.mjs` skip guide results for channels whose grab batch crashed (no output file), instead of recording them as empty, and tag each `guide-map.json` entry and fallback with its batch. Verify: a simulation with one batch file missing records 0 of its sites and all sites of the batch that ran.
- [x] 8.2 Add `tv.mail.ru` to `excludeSites`: its site script crashes the grabber and takes the whole batch with it. Verify: `config.json` parses and the site is listed as excluded in the build log.
- [x] 8.3 Add the per-source `geoBlocked` flag (Samsung, Pluto) so their streams count as geo-blocked to the source's country; Samsung US ranks last for a Canadian viewer and is never dropped. Verify: unit test for the merged US/CA channel and for a US-only channel, and fewer chosen `samsung-us` streams in a local build.
