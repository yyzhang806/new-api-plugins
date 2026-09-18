# Incho 1.1.0 integration

Use the [YinChao platform documentation](https://platform.yinchaoyongxian.com/docs)
with the native API base URL set to `https://<gateway>/incho`. Authenticate with a
**New API token**, not the upstream API key. The upstream key belongs on the
Task Plugin channel bound to `incho`.

The gateway reserves `/api` for its own APIs. The `/incho` namespace avoids that
collision while preserving the platform's complete `/api/v1/...` suffixes,
HTTP methods, parameter names, and JSON response envelopes.

## API coverage

All paths below are relative to the native base URL.

| Method | Platform path | Plugin behavior |
| --- | --- | --- |
| POST | `/api/v1/song/generate` | Normal and reference generation; returns `{id, task_type, choices, create_at}` |
| POST | `/api/v1/song/instrumental` | Instrumental generation with v4.0 |
| POST | `/api/v1/song/extend` | Extension with v3.5; omitted `extend_at` continues from the end |
| POST | `/api/v1/lyric/generate` | Synchronous `{title, lyric}` result |
| POST | `/api/v1/file/upload` | Multipart `file` and `upload_type`; returns `{id}` |
| POST | `/api/v1/task/cancel` | JSON `{id}`; returns `{success, message}` |
| GET | `/api/v1/task/query?task_id=...` | One owned song task, in the platform's task envelope |
| GET | `/api/v1/task/querys?task_ids=a,b` | Up to 100 owned song tasks, in `{tasks: [...]}` |
| GET | `/api/v1/song/stream/{song_id}` | Not registered; play the returned `choices[].pipe_url` directly |

Queries return the gateway's latest persisted upstream snapshot. The host polls
upstream tasks individually; a client batch query does not create extra billable
work or forward a batch request upstream. It checks ownership of every task and
preserves requested ordering. A missing or unowned task rejects the query.
Native plugin errors use `{detail: "..."}`; HTTP status codes are controlled by
the host and are not a transparent copy of the provider's errors.

`pipe_url` is preserved even while a song is in `stream` status. Finished songs
also expose `audio_url`. These native URLs point to the provider. OpenAI Responses
continues to use host-issued artifact URLs for completed audio; its SSE mode
reports progress and the final result, not raw audio bytes.

## Channel and pricing configuration

Enable the following model names on the bound channel and in any token model
allowlists:

| Gateway model | Operations | Usage facts |
| --- | --- | --- |
| `incho_music` | Normal, reference, instrumental, extension | `clips: requested n` initially, completed `done` songs at settlement; `action: music` |
| `incho_lyric` | Independent lyrics | `clips: 1`, `action: lyric` |
| `incho_upload` | File upload | `clips: 0`, `action: upload` |
| `incho_cancel` | Task cancellation | `clips: 0`, `action: cancel` |

Keep existing `incho_music` prices and expressions. Set a separate price for
`incho_lyric`. Use task-usage expressions based on `u("clips")` to charge for
actual completed songs or successful lyrics requests. Configured per-call
pricing remains per-call and does not automatically multiply by the song count.
A song with status `done` counts even if its audio URL is absent; failed and
cancelled songs do not count. Fully failed tasks use the host's refund flow.

Set the task-usage expression for **both `incho_upload` and `incho_cancel`** to
`tier("free", 0)`. Reporting zero clips does not override an administrator's
per-call price or nonzero constant expression. No prices or channel settings are
automatically changed when installing the plugin.

Uploads and their subsequent generation must share a channel that enables both
`incho_upload` and `incho_music`. Every channel whose tasks must be cancellable
must also enable `incho_cancel`. Origin-task ownership checks pin follow-up
operations to that channel, including on retry.

The native song body's `model` is the provider version (`v3.5` or `v4.0`), while
billing/channel selection uses `incho_music`. A channel model mapping to a
provider version overrides the native body version. Do not force `v4.0` on a
channel intended for reference or extension requests, which require `v3.5`.

## Generation parameters

| Mode | Provider model | Prompt limit | Lyric limit | Default n |
| --- | --- | --- | --- | --- |
| Normal | v3.5 / v4.0 (default v4.0) | 1,000 / 3,000 | 3,000 / 5,000 | 2 |
| Reference | v3.5 (default) | 1,000, optional | 3,000, optional | 2 |
| Extension | v3.5 (default) | Not sent | 3,000, optional | 2 |
| Instrumental | v4.0 (default) | 3,000, required | Not sent | 2 |
| Independent lyrics | No model parameter | 2,000, required | Generated | N/A |

Limits count Unicode code points. Normal mode accepts prompt or custom lyrics,
retaining the previous plugin's lyrics-only support. `n` is 1 or 2. The historical
`gpt_description_prompt` alias remains supported for song prompts.

Reference requests use `task_type: "reference"`, `reference_audio`, and optional
`similarity` in `[0.2, 0.8, 1.3, 1.5]`. Extension requests use `origin_audio` and
optional nonnegative numeric `extend_at`; zero is preserved. Audio references
use the platform's `{audio_type, audio_content}` structure.

The current platform [generation guide](https://platform.yinchaoyongxian.com/docs/guides/prompt-generate)
specifies v4.0 limits of 3,000/5,000 characters; its older August changelog still
mentions a 1,000-character prompt limit. This version follows the current guide.

## IDs, uploads, and follow-up operations

IDs returned by the gateway are opaque strings, not provider UUIDs. Store and
reuse them unchanged:

- Task IDs and upload IDs are gateway task IDs (`task_...`).
- Song IDs on the new routes are scoped to their parent task
  (`task_...:song:<song-id>`). They stay stable when choice ordering changes.
- `audio_type: "upload_id"` accepts the ID returned by this gateway's upload
  route. The upload must have completed with the matching `upload_type`.
- `audio_type: "audio_id"` accepts a completed song ID from the new task routes.
  Query older song tasks through the new query route to obtain scoped song IDs.
- `audio_type: "audio_url"` accepts a public HTTP(S) audio URL. It needs no
  gateway resource lookup and is fetched by the provider.

Raw upstream upload/song IDs are not accepted as gateway-owned references. This
prevents one gateway user from using another user's assets on a shared upstream
account. The host verifies origin ownership before the driver resolves private
IDs. Do not strip or parse the public reference yourself.

Example using an existing local MP3:

```bash
export INCHO_BASE='https://<gateway>/incho'
export NEW_API_TOKEN='<gateway-token>'

curl "$INCHO_BASE/api/v1/file/upload" \
  -H "Authorization: Bearer $NEW_API_TOKEN" \
  -F 'file=@reference.mp3' -F 'upload_type=reference'

# Copy the returned id into audio_content.
curl "$INCHO_BASE/api/v1/song/generate" \
  -H "Authorization: Bearer $NEW_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"v3.5","task_type":"reference","reference_audio":{"audio_type":"upload_id","audio_content":"task_UPLOAD_ID"},"similarity":0.8,"n":1}'

curl "$INCHO_BASE/api/v1/task/query?task_id=task_SONG_TASK_ID" \
  -H "Authorization: Bearer $NEW_API_TOKEN"
```

Uploads accept one MP3 or WAV file of at most 10 MiB. For extension uploads,
use `upload_type=extend`. Lyrics, uploads, and cancellation complete within their
native HTTP request; internally the host persists a terminal operation record
for ownership and billing. They are not polled as song-generation tasks.

Cancellation sends the owned task's private upstream ID to the platform. The
response indicates whether the platform accepted cancellation, not whether all
songs have already stopped. Normal polling updates the original task and
settles/refunds it. Partial success charges only the completed song count when
using completion-based pricing. A provider response `{success: false, message}`
is returned unchanged; the cancellation operation itself consumes zero clips.

The optional `callback` is passed directly to the platform for song operations.
Callbacks retain **upstream** task/song IDs and do not pass through the gateway
or update its task state. Do not use callback IDs as gateway query/cancel IDs;
use the IDs from native submission/query responses and treat callbacks as a
notification to query again.

## OpenAI Responses and compatibility

`POST /v1/responses` supports `incho_music`, `incho_lyric`, and aliases mapped to
those names. Send the prompt in `input` and provider parameters in `metadata`.
For music, `metadata.task_type` selects `normal`, `reference`, `instrumental`, or
`extend`; reference/origin audio uses the same gateway IDs described above.
All three Responses modes remain supported: synchronous, streaming, background.

```json
{
  "model": "incho_music",
  "input": "Gentle piano and strings",
  "metadata": { "task_type": "instrumental", "model": "v4.0", "n": 1 },
  "background": true
}
```

`/incho/submit/music` and `/incho/fetch/:task_id` remain available with their
previous `{code, message, data}` envelopes. Prefer the platform-aligned paths
for new clients. Published 1.0.x source directories are unchanged.

## Development checks

With a sibling `new-api` checkout and Node.js 22 or newer:

```bash
node --test tests/incho/plugin.test.mjs
cd tools/pluginindex
go test -v .
go run . check ../..
```

The Node suite checks request/response flows and edge cases. The Go suite replays
fixtures in the host's JavaScript engine and validates the two changelog files.
These checks use synthetic responses and do not submit billable platform jobs.
