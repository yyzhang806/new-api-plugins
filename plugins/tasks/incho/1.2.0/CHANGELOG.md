---
changelogVersion: 1
plugin: "incho"
version: "1.2.0"
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---
# Changelog

## [1.2.0]

### Added

- Generate instrumental music with v4.5 through `/incho/api/v1/song/instrumental` or Responses metadata with `task_type: "instrumental"`.
- Create reference songs with v3.5 from a public audio URL or a gateway song ID. Gateway references are checked for ownership and use the channel that generated the original song.
- Generate standalone lyrics with `incho_lyric`, through `/incho/api/v1/lyric/generate` or the Responses API. Lyrics return immediately and count as one generation.
- Submit and query songs through the platform-style routes under `/incho/api/v1`, including querying multiple gateway task IDs. Returned song IDs can be reused for reference generation.
- Cancel a song task owned by the caller through `/incho/api/v1/task/cancel`, using `incho_cancel`. Cancellation reports zero generation units.

### Changed

- Ordinary song generation now defaults to v4.5. It accepts up to 3000 prompt characters and 5000 lyric characters, including when the version is selected through a channel model mapping or Responses metadata.
- Reference generation defaults to v3.5, with limits of 1000 prompt characters and 3000 lyric characters. Instrumental generation requires v4.5 and a nonempty prompt of at most 3000 characters.
- Preserve the upstream task response, including song IDs and live playback URLs, in platform-style submission and query results.

### Removed

- Reject v4.0 in new submissions with guidance to select v4.5 instead, matching the current platform model list.
- Reject new song extensions on the extension route and through legacy submissions or Responses metadata. Historical extension tasks remain available for queries and reference generation.

### Fixed

- Count every song marked `done` during completion settlement, including completed songs whose response does not yet contain an audio URL. Failed and cancelled songs are excluded.

### Migration

- Existing `incho_music` per-song prices, billing mode and billing expressions need no reconfiguration for v4.5; there is no new resolution or model pricing tier in this plugin. Completion-based billing now counts all `done` songs, including those without an audio URL.
- Before enabling `incho_lyric` and `incho_cancel` on a channel, configure their prices separately: charge lyrics per generation (`clips = 1`) and set cancellation to zero cost. A fixed per-call cancellation price must also be zero, since that billing mode does not use `clips`. These new model prices are not populated automatically.
- Change explicit v4.0 values in native requests, Responses metadata and channel model mappings to v4.5. Requests that omit the version now use v4.5 for ordinary songs and instrumentals; select v3.5 explicitly when needed for ordinary songs.
- Stop submitting extension requests; the platform has discontinued this capability. Reference generation creates a new song and does not continue an existing one.
- Use gateway task IDs for query and cancellation requests, and the gateway song IDs returned in `choices` for audio references. Raw upstream IDs and uploaded-file IDs are not accepted; use a public audio URL when referencing external audio.
