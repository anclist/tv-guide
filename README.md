# TV guide

Daily-built IPTV playlist and XMLTV guide for TiviMate, from [iptv-org](https://github.com/iptv-org) plus the extra sources below.

**Scope:** every channel from Canada, the US, Venezuela, Peru, Colombia and Spain, plus news and sports channels from any country.

## Sources
| Source | Gives | Notes |
|---|---|---|
| [iptv-org](https://github.com/iptv-org) | Channels, streams, guide sites | Base list. |
| [Free-TV/IPTV](https://github.com/Free-TV/IPTV) | Streams | Preferred stream for any channel it lists. No guide of its own. |
| [TDTChannels](https://github.com/LaQuay/TDTChannels) | Spanish channels + guide | International and event-only groups are skipped. |
| Samsung TV Plus (US, CA, ES) | FAST channels + guide | Playlists from [BuddyChewChew/app-m3u-generator](https://github.com/BuddyChewChew/app-m3u-generator), guides from [i.mjh.nz](https://i.mjh.nz). Streams are geo-blocked to their region. |
| Pluto TV (US, CA, ES) | FAST channels + guide | Configured but `"enabled": false`: Pluto currently rejects these stream links ("channel not permitted for partner"). |

## URLs
| File | Use |
|---|---|
| https://anclist.github.io/tv-guide/playlist-guided.m3u | Channels that have guide data. Default for the TV. |
| https://anclist.github.io/tv-guide/playlist.m3u | All channels, including ones with no schedule. |
| https://anclist.github.io/tv-guide/guide.xml.gz | XMLTV guide. Playlists point to it via `x-tvg-url`. |

## How it works
A GitHub Actions job runs daily at 08:00 UTC:
1. `scripts/build-lists.mjs` reads the iptv-org API and the extra sources. It picks one stream and one guide source per channel, skipping sites marked broken in iptv-org/epg `SITES.md`. Duplicates are merged as described below. Guides for extra sources are downloaded here, trimmed to the kept channels, and written to `guides/extra-<source>.xml`.
2. The iptv-org/epg grabber downloads the guide in batches of up to 100 channels (`batchSize` in `config.json`). A failed batch is logged as a warning and skipped. `scripts/merge-guides.mjs` combines the batches into one guide.
3. `scripts/check-guide.mjs` writes coverage per guide source and per group to the job summary.
4. The files are published on GitHub Pages.

## How duplicates are merged
Channels are matched by iptv-org id, else by country plus normalized name (no accents, case, punctuation or HD/SD suffix). Stream and guide are chosen separately:
- **Stream:** Free-TV first, then iptv-org, then the other sources.
- **Guide:** a channel that already has an iptv-org guide keeps it. A channel without one takes the guide of the first extra source that has it, and that source's stream unless the stream came from Free-TV.
- **US and CA** share FAST lineups, so `sameLineup` treats them as one country when deduping extra sources.

Extra-source channels use tvg-ids like `samsung-es:ES300030ZT` so they never collide with iptv-org ids. The build log lists per-source counts and the name-based matches, to spot wrong merges.

Set TiviMate to update the playlist and EPG daily. FAST stream links are refreshed by each build.

## Changing scope
Edit `config.json`. `countries` takes ISO codes, `intlCategories` takes iptv-org category IDs, and `sitePriority` and `excludeSites` control guide sources. `guideDays` sets how many days to fetch. `extraSources` lists the extra playlists: `id` (tvg-id prefix), `playlist`, `epg`, `country`, optional `skipGroups` (group-title prefixes to drop), `preferStream` and `enabled`. Then run the workflow manually from the Actions tab.

## When the guide looks thin
Open the latest run under Actions and read the "Check coverage" summary. Guide sites break when they change their pages. Broken sites are skipped automatically once iptv-org marks them, or you can add them to `excludeSites`.
