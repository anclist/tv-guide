## Why

The playlist should favour streams that play in Canada and channels whose guide actually fills. Today each build step keeps the first candidate it sees, and nothing checks the result. Free-TV overwrites iptv-org streams without any check. Each channel gets exactly one guide site, with no fallback. A `guides.json` listing beats an extra-source EPG that already holds programmes. Site priority outranks feed match.

Numbers from the 2026-10-11 run and the iptv-org API:
- 183 of 1131 grabbed iptv-org guides came back empty. 893 channels have a second guide site that was never tried.
- 773 channels have alternative streams, and none of them are tested.
- 237 Samsung CA channels lost out to their Samsung US duplicates.

## What Changes

- Change the build order from first-wins passes to **gather → cluster → validate → rank (stream, guide) pairs → grab → record**. Every source contributes candidates to a single pool per channel.
- Add viewer settings to `config.json`: `viewerCountry` (`CA`) and `viewerTimezone` (`America/Toronto`). These drive two rankings:
  - Geo plausibility: a `Geo-blocked` stream is penalised unless the channel's country is the viewer's country.
  - Feed preference: among a channel's feeds, prefer one whose timezone is equivalent to the viewer's.
- Add a stream liveness probe from the build runner. It is a soft signal that builds up over several runs, and failures that look geo-related are not counted. No channel is dropped because of a probe.
- Add `health.json`, published to Pages next to the playlist. It records per-stream probe streaks and per-(site, site_id) guide results. The next run reads it so it can prefer guide sources that are proven to work.
- Fix guide feed matching: a guide whose feed matches the stream's feed now ranks above site priority.
- Derive each candidate's feed from the candidate itself: the iptv-org stream's feed, then the part of `tvg-id` after `@`, then the channel's main feed. A Free-TV stream no longer silently takes over another stream's feed.
- Add an optional second grab pass, run only for channels whose first guide site produced no programmes. It uses the next-ranked site.
- Add diagnostics to the job summary: stale ids, ambiguous feeds, channels whose candidates all look dead, fallback guides used, and the change in each count since the last run.
- **BREAKING (config semantics)**: `preferStream` no longer overrides iptv-org streams outright. It becomes a tiebreak after the reliability tiers. Source order in `extraSources` no longer decides duplicates.

## Capabilities

### New Capabilities
- `channel-selection`: how the build picks one stream and one guide per channel from all sources. Covers clustering, the ranking tiers, viewer geo and timezone rules, liveness and guide-health signals, the fallback grab, and the diagnostics it reports.

### Modified Capabilities
<!-- none: no existing specs in openspec/specs -->

## Impact

- **Code**:
  - `scripts/build-lists.mjs`: the selection steps 2–4b are restructured.
  - New helper modules for ranking, probing and health.
  - `scripts/check-guide.mjs`: new summary sections.
  - A new script to record health after the merge, and a new script to build the fallback batches.
- **Workflow**: `.github/workflows/build.yml` gets these new steps:
  - a fallback grab pass
  - recording health
  - publishing `health.json`

  The runtime grows by the probe time (a few minutes) plus the fallback grab.
- **Config**: new keys `viewerCountry`, `viewerTimezone`, `probe`, `deadAfter`, `fallbackGrab`.
- **Outputs**:
  - `playlist.m3u` and `playlist-guided.m3u` contents change, because different streams and guides get picked.
  - New public file `health.json`.
  - The `tvg-id` scheme does not change: `<id>@<feed>` for iptv-org, `<source>:<id>` for extras.
- **Dependencies**: none. The probe uses the Node 22 built-in `fetch`, and tests use `node:test`.
