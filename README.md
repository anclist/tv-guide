# TV guide

Daily-built IPTV playlist and XMLTV guide for TiviMate, from [iptv-org](https://github.com/iptv-org).

**Scope:** every channel from Canada, the US, Venezuela and Peru, plus news and sports channels from any country.

## URLs
| File | Use |
|---|---|
| https://anclist.github.io/tv-guide/playlist-guided.m3u | Channels that have guide data. Default for the TV. |
| https://anclist.github.io/tv-guide/playlist.m3u | All channels, including ones with no schedule. |
| https://anclist.github.io/tv-guide/guide.xml.gz | XMLTV guide. Playlists point to it via `x-tvg-url`. |

## How it works
A GitHub Actions job runs daily at 08:00 UTC:
1. `scripts/build-lists.mjs` reads the iptv-org API. It picks one stream and one guide source per channel, skipping sites marked broken in iptv-org/epg `SITES.md`.
2. The iptv-org/epg grabber downloads the guide in batches of up to 100 channels (`batchSize` in `config.json`). A failed batch is logged as a warning and skipped. `scripts/merge-guides.mjs` combines the batches into one guide.
3. `scripts/check-guide.mjs` writes coverage per group to the job summary.
4. The files are published on GitHub Pages.

## Changing scope
Edit `config.json`. `countries` takes ISO codes, `intlCategories` takes iptv-org category IDs, and `sitePriority` and `excludeSites` control guide sources. `guideDays` sets how many days to fetch. Then run the workflow manually from the Actions tab.

## When the guide looks thin
Open the latest run under Actions and read the "Check coverage" summary. Guide sites break when they change their pages. Broken sites are skipped automatically once iptv-org marks them, or you can add them to `excludeSites`.
