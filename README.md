# TV guide

Daily-built IPTV playlist and XMLTV guide for TiviMate, from [iptv-org](https://github.com/iptv-org) plus the extra sources below.

**Scope:** every channel from Canada, the US, Mexico, Venezuela, Peru, Colombia and Spain, plus English, Spanish and French news and sports channels from any country.

## Sources
| Source | Gives | Notes |
|---|---|---|
| [iptv-org](https://github.com/iptv-org) | Channels, streams, guide sites | Base list. |
| [Free-TV/IPTV](https://github.com/Free-TV/IPTV) | Streams | Streams, preferred on ties. No guide of its own. |
| [TDTChannels](https://github.com/LaQuay/TDTChannels) | Spanish channels + guide | International and event-only groups are skipped. |
| Samsung TV Plus (US, CA, ES) | FAST channels + guide | Playlists from [BuddyChewChew/app-m3u-generator](https://github.com/BuddyChewChew/app-m3u-generator), guides from [i.mjh.nz](https://i.mjh.nz). Streams are geo-blocked to their region. |
| Plex (MX) | Mexican FAST channels + guide | Playlist from [BuddyChewChew/app-m3u-generator](https://github.com/BuddyChewChew/app-m3u-generator), guide from [i.mjh.nz](https://i.mjh.nz). Plays from Canada. |
| Pluto TV (US, CA, ES) | FAST channels + guide | Configured but `"enabled": false`: Pluto currently rejects these stream links ("channel not permitted for partner"). |

## URLs
| File | Use |
|---|---|
| https://anclist.github.io/tv-guide/playlist-guided.m3u | Channels that have guide data. Default for the TV. |
| https://anclist.github.io/tv-guide/playlist.m3u | All channels, including ones with no schedule. |
| https://anclist.github.io/tv-guide/guide.xml.gz | XMLTV guide. Playlists point to it via `x-tvg-url`. |
| https://anclist.github.io/tv-guide/health.json | Probe and guide results, used by the next build. |

## How it works
A GitHub Actions job runs daily at 08:00 UTC:
1. `scripts/build-lists.mjs` reads the iptv-org API, the extra sources and the previous run's `health.json`. It probes every candidate stream, then picks one stream and one guide per channel (see below), skipping sites marked broken in iptv-org/epg `SITES.md`. Guides for extra sources are downloaded here, trimmed to the kept channels, and written to `guides/extra-<source>.xml`.
2. The iptv-org/epg grabber downloads the guide in batches of up to 100 channels (`batchSize` in `config.json`). A failed batch is logged as a warning and skipped.
3. With `fallbackGrab` on, `scripts/fallback-batches.mjs` finds channels whose guide came back empty and grabs them again from their next-best site. `scripts/merge-guides.mjs` combines everything into one guide.
4. `scripts/record-health.mjs` writes `health.json`: probe streaks per stream and programme counts per guide site, read back by the next run.
5. `scripts/check-guide.mjs` writes coverage and selection diagnostics, with the change since the last run, to the job summary.
6. The files are published on GitHub Pages.

## How a channel's stream and guide are picked
Candidates from every source are pooled per channel: matched by iptv-org id (any `@feed` suffix ignored), else by country plus normalized name (no accents, case, punctuation or HD/SD suffix). US and CA share FAST lineups, so `sameLineup` treats them as one country here. Source order in `config.json` does not matter.

Each (stream, guide) pair is then compared tier by tier; a later tier only breaks ties:
1. Stream not dead: failed the probe on `deadAfter` runs in a row. HTTP 401/403/451 look like geo blocks from the US runner and never count.
2. Stream plausible for `viewerCountry`: a `Geo-blocked` stream only counts as plausible when the channel is from that country. Streams from extra sources with `"geoBlocked": true` (Samsung, Pluto) count as geo-blocked to the source's `country`, so for a Canadian viewer Samsung US ranks last and is used only when nothing else carries the channel. `Not 24/7` ranks just below plausible.
3. Has a guide.
4. Guide feed matches stream feed (East/West schedules).
5. Guide proven: an extra-source guide with programmes now, or an iptv-org site that delivered programmes last run. One that came back empty ranks last.
6. Source from `viewerCountry` (e.g. Samsung CA over Samsung US), then `preferStream` sources (Free-TV).
7. Stream feed in the same timezone as `viewerTimezone`.
8. Guide site priority, then streams that need no user-agent/referrer, then quality.

No channel is dropped by the probe; the job summary lists channels whose streams all look dead. A channel whose best stream is still geo-blocked for `viewerCountry` (e.g. Samsung US-only channels) goes to its own group, `<country> · Geo-blocked`.

Extra-source channels use tvg-ids like `samsung-es:ES300030ZT` so they never collide with iptv-org ids. The build log and job summary list per-source counts, name-based matches, stale ids (ids from your countries that iptv-org no longer has, usually a rename) and ambiguous feeds, to spot wrong merges.

Set TiviMate to update the playlist and EPG daily. FAST stream links are refreshed by each build.

## Changing scope
Edit `config.json`. `countries` takes ISO codes, `intlCategories` takes iptv-org category IDs, `intlLanguages` takes ISO 639-3 codes (e.g. `eng`, `spa`, `fra`) that those out-of-country channels must speak (empty list = any language), and `sitePriority` and `excludeSites` control guide sources. `guideDays` sets how many days to fetch. `extraSources` lists the extra playlists: `id` (tvg-id prefix), `playlist`, `epg`, `country`, optional `skipGroups` (group-title prefixes to drop), `preferStream` (tiebreak preference), `geoBlocked` (streams only play in the source's `country`) and `enabled`. Then run the workflow manually from the Actions tab.

Selection settings: `viewerCountry` and `viewerTimezone` describe where the TV is (geo and East/West feed preference). `probe.timeoutMs` and `probe.concurrency` tune the stream probe, `deadAfter` is how many failed runs in a row mark a stream dead, and `fallbackGrab` turns the second guide grab on or off.

## When the guide looks thin
Open the latest run under Actions and read the "Check coverage" summary. Guide sites break when they change their pages. Broken sites are skipped automatically once iptv-org marks them, or you can add them to `excludeSites`.
