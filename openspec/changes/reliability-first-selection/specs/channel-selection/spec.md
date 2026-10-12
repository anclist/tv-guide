## Purpose

Defines how the daily build picks, for each channel, the one stream and the one guide most likely to work for the configured viewer. All sources are pooled, candidates are validated, and the outcome is fed back into the next run.

## ADDED Requirements

### Requirement: One entry per channel across all sources
The build SHALL gather stream and guide candidates from iptv-org and from every enabled extra source into one pool per channel before choosing anything. Candidates SHALL be grouped as one channel in this order:
1. By iptv-org channel id, ignoring any `@feed` suffix.
2. Otherwise by country plus normalized name, with countries in the same `sameLineup` group treated as one.
3. Otherwise each candidate forms its own channel.

The order of sources in `config.json` SHALL NOT decide which candidate wins.

#### Scenario: Feed-qualified tvg-id joins the iptv-org channel
- **WHEN** an extra source lists `tvg-id="ABC.us@East"` and `ABC.us` is a selected iptv-org channel
- **THEN** the candidate joins the `ABC.us` channel, with feed `East`

#### Scenario: Same FAST channel in two lineups
- **WHEN** `samsung-us` and `samsung-ca` both list a channel with the same normalized name, and US and CA share a lineup
- **THEN** the playlist contains that channel once

#### Scenario: Source order does not decide the winner
- **WHEN** the order of `extraSources` in `config.json` is swapped and no candidate's data changes
- **THEN** the same stream and guide are chosen for every channel

### Requirement: Pair ranking favours a working link, then a working guide
For each channel the build SHALL choose one (stream, guide) pair. The pair may have no guide. Pairs SHALL be compared tier by tier, in this order, and a later tier SHALL only decide between pairs that tie on every earlier tier:
1. The stream is not considered dead.
2. The stream is plausible for the viewer's country and is available 24/7.
3. The pair has a guide.
4. The guide's feed matches the stream's feed.
5. The guide is proven: it has programmes now, or it produced programmes on the last run.
6. The candidate's source country equals the viewer's country, and then the source is a `preferStream` source.
7. The stream's feed timezone is equivalent to the viewer's timezone.
8. Guide site priority, then the stream needs no user-agent or referrer, then stream quality.

#### Scenario: Feed match beats site priority
- **WHEN** a channel's stream is feed `East`, the higher-priority site only has a `West` guide, and a lower-priority site has an `East` guide
- **THEN** the `East` guide from the lower-priority site is chosen

#### Scenario: Proven extra EPG beats an unproven listing
- **WHEN** a channel has an iptv-org guide listing whose (site, site_id) has no record of programmes, and an extra-source EPG that has programmes in the guide window
- **THEN** the extra-source EPG is chosen as the guide

#### Scenario: Free-TV no longer overrides blindly
- **WHEN** a Free-TV stream has been considered dead for `deadAfter` runs and an iptv-org stream for the same channel is not dead
- **THEN** the iptv-org stream is chosen

### Requirement: Geo plausibility relative to the viewer
The build SHALL read `viewerCountry` from config. A stream labelled `Geo-blocked` SHALL count as plausible only when its channel's country equals `viewerCountry`. A stream from an extra source configured with `geoBlocked: true` SHALL be treated as `Geo-blocked` to that source's own country, regardless of the channel it joins. A stream labelled `Not 24/7` SHALL rank below plausible streams without that label, and above streams that are geo-blocked for the viewer.

#### Scenario: Canadian geo-blocked stream is kept for a Canadian viewer
- **WHEN** `viewerCountry` is `CA` and a CA channel's only clean alternative is lower quality than a `Geo-blocked` stream
- **THEN** the geo-blocked stream is not penalised for geo, and quality decides between them

#### Scenario: Samsung US ranks last for a Canadian viewer
- **WHEN** `viewerCountry` is `CA`, `samsung-us` is configured with `geoBlocked: true` and `country: "US"`, and a channel has a `samsung-us` stream and a `samsung-ca` stream
- **THEN** the `samsung-ca` stream is chosen, and a channel whose only stream is from `samsung-us` stays in the playlist with that stream

#### Scenario: Geo-blocked leftovers get their own group
- **WHEN** `viewerCountry` is `CA` and a US channel's chosen stream is still geo-blocked for the viewer, because no plausible candidate exists
- **THEN** the channel is listed under the group `US · Geo-blocked` instead of its category group

#### Scenario: US geo-blocked stream loses to a clean stream
- **WHEN** `viewerCountry` is `CA`, a US channel has a 1080p `Geo-blocked` stream and a 720p unlabelled stream
- **THEN** the 720p unlabelled stream is chosen

### Requirement: Candidate feed and viewer timezone
Each stream candidate's feed SHALL be taken from, in order: the feed in its iptv-org stream record, the part of its `tvg-id` after `@`, and the channel's main feed. A candidate SHALL NOT inherit the feed of another candidate. Feed timezones SHALL count as matching `viewerTimezone` when they have the same UTC offset in both January and July.

#### Scenario: Free-TV stream keeps its own feed
- **WHEN** a Free-TV candidate has no `@feed` in its tvg-id, and the iptv-org stream for that channel is feed `West`
- **THEN** the Free-TV candidate's feed is the channel's main feed, not `West`

#### Scenario: New York feed matches Toronto viewer
- **WHEN** `viewerTimezone` is `America/Toronto` and a feed lists `America/New_York`
- **THEN** that feed counts as matching the viewer's timezone

### Requirement: Stream liveness is a soft, multi-run signal
The build SHALL probe each candidate stream URL from the runner. A stream SHALL count as dead only after `deadAfter` consecutive runs (default 3) with a failure that is not geo-related. Timeouts, DNS errors, HTTP 404, HTTP 5xx and non-playlist responses count as failures. HTTP 401, 403 and 451 count as geo-related and SHALL NOT increase the failure streak. A successful probe SHALL reset the streak. No channel SHALL be removed from the playlist because of probe results alone.

#### Scenario: Canadian stream refused by the US runner
- **WHEN** a CA channel's stream returns HTTP 403 to the runner on every run
- **THEN** the stream is never considered dead, and the channel stays in the playlist

#### Scenario: One-off timeout
- **WHEN** a stream times out on one run and succeeds on the next
- **THEN** its failure streak goes back to 0, and it is never considered dead

#### Scenario: All candidates dead
- **WHEN** every stream candidate of a channel is considered dead
- **THEN** the channel stays in the playlist with its best-ranked stream, and the job summary lists it under all-dead channels

### Requirement: Health record published and reused
After each successful build, the build SHALL publish `health.json` alongside the playlists. It SHALL contain:
- per stream (keyed by URL without the query string): the failure streak and the last success time
- per (site, site_id) guide source: the programme count from the last grab, the empty streak, and the last success time
- the summary counts used for the day-over-day comparison

The next build SHALL read the published `health.json` before ranking. If it is missing or unreadable, the build SHALL proceed and treat every stream and guide as unknown.

#### Scenario: Cold start
- **WHEN** no `health.json` has been published yet
- **THEN** the build completes, no stream is considered dead, and no iptv-org guide counts as proven

#### Scenario: Guide failure remembered
- **WHEN** the grab for (site, site_id) yields no programmes on a run
- **THEN** the next run ranks that guide below any other guide candidate of the same channel that is proven or unknown

### Requirement: Fallback guide grab
When `fallbackGrab` is enabled, the build SHALL grab a second time for channels whose chosen iptv-org guide produced no programmes. The second grab SHALL use each channel's next-ranked guide candidate from a different site, under the same `tvg-id`. Channels without such a candidate are skipped. Fallback results SHALL be merged into the published guide and recorded in `health.json`.

#### Scenario: First site empty, second site works
- **WHEN** a channel's chosen site returns no programmes and its next-ranked candidate is on another site that returns programmes
- **THEN** the published guide has programmes for that channel's `tvg-id`, and the summary counts it as a fallback used

#### Scenario: Fallback disabled
- **WHEN** `fallbackGrab` is false
- **THEN** no second grab runs

### Requirement: Selection diagnostics in the job summary
The build SHALL add the following to the job summary, each with its change since the previous run's counts:
- stale ids, per source: ids that look like iptv-org ids, carry a country code from `countries`, and are not in the full channel list
- ambiguous feeds: candidates of multi-feed channels whose feed came from the main-feed default
- the count of all-dead channels
- fallback guides used
- the guide coverage counts already reported today

#### Scenario: Upstream rename
- **WHEN** an extra source lists a `tvg-id` that is not in the iptv-org channel list at all
- **THEN** the summary lists it under stale ids for that source, and the count's change against the previous run is shown

#### Scenario: Id from another country is not reported
- **WHEN** an extra source lists `tvg-id="Seven.au"`, it is not in the iptv-org channel list, and `AU` is not in `countries`
- **THEN** it is not listed as stale

#### Scenario: Out-of-scope id is not stale
- **WHEN** an extra source lists a `tvg-id` that exists in the iptv-org channel list but whose channel is not selected
- **THEN** it is not listed as stale
