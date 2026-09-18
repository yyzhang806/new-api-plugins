---
changelogVersion: 1
plugin: "incho"
version: "1.1.0"
locale: "zh-CN"
---
# Changelog

## [1.1.0]

### Added

- 新增原生 `/incho/api/v1/song/generate`、`/song/instrumental`、`/song/extend`、`/lyric/generate`、`/file/upload`、`/task/cancel`、`/task/query` 和 `/task/querys` 路由，所有相对 `/incho/api/v1` 的后缀均与平台 API 一致。原生响应采用平台的任务、歌词、上传、取消和批量查询结构。
- 支持通过 `reference_audio` 和 `similarity` 仿写、通过 `origin_audio` 和可选 `extend_at` 扩写、生成纯音乐，以及透传 `callback`。音频输入支持 URL、网关上传 ID 和网关歌曲 ID。
- 新增 `incho_lyric` 同步歌词生成、`incho_upload` multipart MP3/WAV 上传（最大 10 MiB）和 `incho_cancel` 任务取消。上传与取消报告零计费数量；取消响应保留上游接受或拒绝请求的结果。
- OpenAI Responses 可通过 metadata 使用仿写、扩写和纯音乐模式，并可用 `incho_lyric` 生成歌词。原生任务响应保留 `pipe_url`，支持边生成边播放。

### Changed

- 仿写与扩写默认使用 `v3.5`，普通生歌与纯音乐默认使用 `v4.0`。校验平台支持的模型与模式组合，保留默认生成两首歌曲的行为，并正确传递显式 `extend_at: 0`。
- v4.0 提示词和歌词上限分别提升至 3,000 和 5,000 个 Unicode 字符；v3.5 分别保持 1,000 和 3,000 个字符。独立歌词生成的提示词上限为 2,000 个字符。
- 所有生歌模式沿用 `incho_music` 及其 `clips`、`action: music` 用量协议。为独立模型增加 `lyric`、`upload` 和 `cancel` 用量动作。

### Deprecated

- `/incho/submit/music` 和 `/incho/fetch/:task_id` 标记为旧接口，建议使用与平台一致的新路由。旧路由及响应结构继续保留。

### Fixed

- 提交后保留任务中的歌曲和流播放地址，不再丢弃到首次轮询；不再把仿写请求静默转换成普通生歌。
- 完成计费统计所有上游状态为 `done` 的歌曲，包括暂缺 `audio_url` 的歌曲；部分完成的任务保持处理中，并拒绝任务 ID 不匹配的轮询响应。

### Security

- 新路由返回带网关归属的上传和歌曲引用。使用上游 ID 前通过宿主校验的来源任务进行解析，为仿写、扩写与取消操作校验资源归属并固定原渠道。

### Migration

- **价格影响：** 现有 `incho_music` 价格、计费模式和表达式无需仅因本次升级重新配置；本次没有分辨率档位。按完成量结算的表达式现在也会统计缺少音频 URL 的 `done` 歌曲。按次计费仍按请求计费；如需按实际完成歌曲数计费，应采用基于 `u("clips")` 的任务用量表达式。升级不会自动迁移已保存的价格或表达式。
- **新增模型定价：** 在所需渠道和令牌模型白名单中加入 `incho_lyric`、`incho_upload` 和 `incho_cancel`。歌词单独定价，每次成功请求计一份用量。上传与取消使用任务用量表达式 `tier("free", 0)`，确保操作免费；零用量不会覆盖已配置的按次价格。需要取消任务的每个渠道都要启用 `incho_cancel`，接收上传并用于后续生成的渠道需同时启用 `incho_music`。
- 将客户端原生 API Base URL 设为 `<网关地址>/incho`，沿用平台 `/api/v1/...` 后缀。原样使用返回的网关 ID；任务和上传 ID 不再是上游 UUID，歌曲 ID 包含所属网关任务 ID。可通过新查询接口读取已有歌曲任务，获取带归属的歌曲引用。
- 回调由平台直接发送，保留上游 ID，不会更新网关任务状态。取消接口立即返回受理结果，原任务状态和退款随后通过常规轮询更新。直接播放返回的 `pipe_url`；不注册网关 `/song/stream/{song_id}` 二进制路由。
