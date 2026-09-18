---
changelogVersion: 1
plugin: "incho"
version: "1.1.0"
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---
# Changelog

## [1.1.0]

### Added

- Add native `/incho/api/v1/song/generate`, `/song/instrumental`, `/song/extend`, `/lyric/generate`, `/file/upload`, `/task/cancel`, `/task/query`, and `/task/querys` routes, with every suffix relative to `/incho/api/v1` matching the platform API. Native responses use the platform's task, lyrics, upload, cancellation, and batch envelopes.
- Support reference generation with `reference_audio` and `similarity`, extension with `origin_audio` and optional `extend_at`, instrumental generation, and `callback` forwarding. Audio inputs accept URLs, gateway upload IDs, or gateway song IDs.
- Add synchronous lyrics generation under `incho_lyric`, multipart MP3/WAV uploads up to 10 MiB under `incho_upload`, and task cancellation under `incho_cancel`. Upload and cancellation operations report zero billable clips; cancellation results preserve both successful and rejected upstream responses.
- Extend OpenAI Responses support to reference, extension, and instrumental requests through metadata, and to lyrics requests using `incho_lyric`. Preserve `pipe_url` in native task responses for live playback.

### Changed

- Default reference and extension requests to `v3.5`; normal and instrumental generation default to `v4.0`. Enforce the platform's supported model/mode combinations, preserve the default of two songs, and accept an explicit `extend_at: 0`.
- Raise v4.0 prompt and lyric limits to 3,000 and 5,000 Unicode characters respectively; retain v3.5 limits of 1,000 and 3,000 characters. Independent lyrics prompts allow up to 2,000 characters.
- Keep `incho_music` and its `clips`/`action: music` usage contract for all song generation modes. Add `lyric`, `upload`, and `cancel` usage actions for their separate models.

### Deprecated

- Deprecate `/incho/submit/music` and `/incho/fetch/:task_id` in favor of the platform-aligned routes. The legacy routes and their response envelopes remain available.

### Fixed

- Preserve submitted task choices and live playback URLs instead of discarding them until the first poll, and stop silently converting reference requests to normal generation.
- Count every song with upstream status `done` for completion billing, including songs without an `audio_url`; keep partially completed tasks in progress and reject polling responses for a different task ID.

### Security

- Return gateway-scoped upload and song references on the new routes. Resolve them through host-verified origin tasks before using upstream IDs, enforcing resource ownership and channel affinity for reference, extension, and cancellation requests.

### Migration

- **Pricing impact:** Existing `incho_music` prices, billing mode, and expressions require no reconfiguration solely for this release; no resolution tiers are introduced. Completion-based expressions now count `done` songs even if their audio URL is missing. Per-call pricing retains its per-request behavior; use a task-usage expression based on `u("clips")` if actual completed-song billing is required. No saved prices or expressions are automatically migrated.
- **New model pricing:** Add `incho_lyric`, `incho_upload`, and `incho_cancel` to applicable channels and token model allowlists. Configure a separate lyrics price for one clip per successful request. Configure upload and cancellation task-usage expressions as `tier("free", 0)` to keep these operations free; zero usage alone does not override a configured per-call price. Include `incho_cancel` on every channel whose tasks must be cancellable, and `incho_music` on channels that accept uploads for later generation.
- Set the client's native API base to `<gateway>/incho` and keep the platform's `/api/v1/...` suffixes. Use returned gateway IDs unchanged; task/upload IDs are not upstream UUIDs, and song IDs include their parent gateway task ID. Existing song tasks can be queried through the new route to obtain scoped song references.
- Callbacks are delivered directly by the platform and retain upstream IDs; they do not update gateway task state. Cancellation acceptance is returned immediately, while the original task's status and refund follow normal polling. Play the returned `pipe_url` directly; a gateway `/song/stream/{song_id}` binary route is not registered.
