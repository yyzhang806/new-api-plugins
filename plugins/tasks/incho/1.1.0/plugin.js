/**
 * Incho task plugin. Upstream contract: https://platform.yinchaoyongxian.com/docs
 * Native base URL: <gateway>/incho; preserve the upstream /api/v1 suffixes.
 * The host reserves /api and native presenters return JSON only. Live audio is
 * exposed through the provider's pipe_url, not a fake JSON song/stream route.
 * Lyrics, uploads and cancellation use the host's immediate-completion contract.
 * Asset IDs are gateway references so originTasks enforces ownership and pins
 * reference/extend/cancel operations to the channel that created the resource.
 */

export const meta = {
  apiVersion: 1,
  key: "incho",
  name: "Incho",
  sortPriority: 100,
  icon: "text",
  description: {
    en: "Incho songs, instrumentals, reference audio, extensions and lyrics",
    zh: "音潮歌曲、纯音乐、仿写、扩写与歌词生成",
  },
  version: "1.1.0",
  author: { name: "yyzhang806" },
  website: "https://platform.yinchaoyongxian.com/?register_channel=new",
  baseUrl: "https://open.yinchaoyongxian.com",
  models: ["incho_music", "incho_lyric", "incho_upload", "incho_cancel"],
  fetchMode: "per_task",
  usageSchema: {
    clips: {
      type: "number",
      unit: "count",
      description: { en: "Song or lyrics generation unit price", zh: "生成歌曲或歌词单价" },
    },
    action: {
      enum: ["music", "lyric", "upload", "cancel"],
      enumLabels: {
        music: { en: "Generate songs", zh: "生成歌曲" },
        lyric: { en: "Generate lyrics", zh: "生成歌词" },
        upload: { en: "Upload audio", zh: "上传音频" },
        cancel: { en: "Cancel task", zh: "取消任务" },
      },
      description: { en: "Generate music or manage tasks", zh: "生成音乐或管理任务" },
    },
  },
  protocols: [{ name: "openai_responses", supports: ["stream", "sync", "background"], models: ["incho_music", "incho_lyric"] }],
  routes: [
    { method: "POST", path: "/incho/api/v1/song/generate", type: "submit", decode: "decodeGenerate", render: "renderPlatformTask" },
    { method: "POST", path: "/incho/api/v1/song/instrumental", type: "submit", decode: "decodeInstrumental", render: "renderPlatformTask" },
    { method: "POST", path: "/incho/api/v1/song/extend", type: "submit", decode: "decodeExtend", render: "renderPlatformTask" },
    { method: "POST", path: "/incho/api/v1/lyric/generate", type: "submit", decode: "decodeLyric", render: "renderImmediate" },
    { method: "POST", path: "/incho/api/v1/file/upload", type: "submit", decode: "decodeUpload", render: "renderUpload" },
    { method: "POST", path: "/incho/api/v1/task/cancel", type: "submit", decode: "decodeCancel", render: "renderImmediate" },
    { method: "GET", path: "/incho/api/v1/task/query", type: "dynamic", decode: "decodeQuery", render: "renderPlatformQuery" },
    { method: "GET", path: "/incho/api/v1/task/querys", type: "dynamic", decode: "decodeQueries", render: "renderPlatformQueries" },
    { method: "POST", path: "/incho/submit/:action", type: "submit", decode: "decodeSubmit", render: "renderSubmit" },
    { method: "GET", path: "/incho/fetch/:task_id", type: "query", render: "renderTask" },
  ],
};

const API_PREFIX = "/api/v1";
// Identifies traffic that reaches Incho through this plugin, so the channel can be
// measured separately from direct API integrations.
const SOURCE_TAG = "plugins";
const USER_AGENT = "incho-newapi-plugin/1.1.0";
const DEFAULT_MODEL = "v4.0";
const MAX_UPLOAD = 10 * 1024 * 1024;

function trimmed(value) {
  return String(value || "").trim();
}

function responsesText(req) {
  const texts = [];
  const input = req.input;
  if (typeof input === "string") texts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = item.content === undefined ? [item] : Array.isArray(item.content) ? item.content : [item.content];
      for (const part of content) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        if (["input_text", "text"].includes(part.type) && typeof part.text === "string") texts.push(part.text);
      }
    }
  }
  return texts
    .filter(function (text) {
      return trimmed(text);
    })
    .join("\n");
}

function actionName(ctx) {
  return String((ctx.params || {}).action || ctx.action || "").toUpperCase();
}

function authHeaders(ctx) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: "Bearer " + ctx.apiKey,
    "X-Incho-Source": SOURCE_TAG,
    "User-Agent": USER_AGENT,
  };
}

// --- native decode -----------------------------------------------------------

function jsonBody(ctx) {
  if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
  const body = ctx.body.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
  return body;
}

function textField(body, key, limit, required) {
  const value = body[key];
  if (value != null && typeof value !== "string") throw new Error(key + " must be a string");
  const text = value == null ? "" : value;
  if (required && !text.trim()) throw new Error(key + " is required");
  if (limit && Array.from(text).length > limit) throw new Error(key + " must be at most " + limit + " characters");
  return text;
}

function publicTaskId(value) {
  if (typeof value !== "string" || !/^task_[A-Za-z0-9_-]+$/.test(value))
    throw new Error("use the gateway task or upload id returned by this plugin");
  return value;
}

function songReference(value) {
  if (typeof value !== "string") throw new Error("audio_id must be a gateway song id");
  const match = /^(task_[A-Za-z0-9_-]+):song:([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new Error("audio_id must be a gateway song id returned in choices");
  return { taskId: match[1], songId: match[2] };
}

function audioReference(audio, name) {
  if (!audio || typeof audio !== "object" || Array.isArray(audio)) throw new Error(name + " is required");
  if (!["upload_id", "audio_id", "audio_url"].includes(audio.audio_type)) throw new Error(name + ".audio_type must be upload_id, audio_id or audio_url");
  const content = textField(audio, "audio_content", 0, true);
  if (audio.audio_type === "upload_id") return publicTaskId(content);
  if (audio.audio_type === "audio_id") return songReference(content).taskId;
  if (!/^https?:\/\/[^\s]+$/i.test(content)) throw new Error(name + ".audio_content must be an HTTP(S) URL");
  return "";
}

function submitIntent(body, action, model) {
  const intent = { kind: "submit", model: model || "incho_music", action: action, requestBody: body };
  const reference = action === "MUSIC" && body.task_type === "reference";
  const audio = action === "EXTEND" ? body.origin_audio : reference ? body.reference_audio : null;
  if (audio || action === "EXTEND" || reference) {
    const id = audioReference(audio, action === "EXTEND" ? "origin_audio" : "reference_audio");
    if (id) intent.originTaskIds = [id];
  }
  return intent;
}

function decodeNativeSubmit(ctx) {
  if (actionName(ctx) !== "MUSIC") throw new Error("action must be music; use POST /incho/submit/music");
  return submitIntent(jsonBody(ctx), "MUSIC");
}

function resolveAudio(ctx, audio, name, uploadType) {
  const id = audioReference(audio, name);
  if (!id) return { audio_type: audio.audio_type, audio_content: audio.audio_content };
  const origin = (ctx.originTasks || []).find(function (task) { return task.taskId === id; });
  if (!origin) throw new Error("audio origin task was not resolved by the gateway");
  if (audio.audio_type === "upload_id") {
    if (origin.action !== "UPLOAD" || origin.status !== "SUCCESS" || !origin.data || origin.data.upload_type !== uploadType)
      throw new Error("upload_id must identify a successful " + uploadType + " upload");
    return { audio_type: "upload_id", audio_content: origin.upstreamTaskId };
  }
  if (!["MUSIC", "INSTRUMENTAL", "EXTEND"].includes(origin.action)) throw new Error("audio_id must identify a song task");
  const songId = songReference(audio.audio_content).songId;
  const song = songData(origin.data).find(function (item) { return item && item.id === songId; });
  if (!song || song.status !== "done" || !trimmed(song.id)) throw new Error("audio_id must identify a completed song");
  return { audio_type: "audio_id", audio_content: song.id };
}

function songCount(body) {
  if (body.n == null) return 2;
  const n = typeof body.n === "number" || typeof body.n === "string" ? Number(body.n) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 2) throw new Error("n must be 1 or 2");
  return n;
}

function validateAndNormalize(ctx) {
  const incoming = ctx.requestBody || {};
  const action = actionName(ctx);
  if (!["MUSIC", "INSTRUMENTAL", "EXTEND"].includes(action)) throw new Error("unsupported song action");
  const taskType = action === "INSTRUMENTAL" ? "instrumental" : action === "EXTEND" ? "extend" : incoming.task_type == null ? "normal" : incoming.task_type;
  if (action === "MUSIC" && !["normal", "reference"].includes(taskType)) throw new Error("task_type must be normal or reference; use the instrumental or extend endpoint for other modes");
  if (action !== "MUSIC" && incoming.task_type != null && incoming.task_type !== taskType) throw new Error("task_type does not match the endpoint");
  const upstreamModel = trimmed(ctx.upstreamModel);
  const mappedModel = upstreamModel && upstreamModel !== trimmed(ctx.model) && upstreamModel !== "incho_music" ? upstreamModel : "";
  let model = mappedModel || trimmed(incoming.model) || (taskType === "reference" || taskType === "extend" ? "v3.5" : DEFAULT_MODEL);
  if (model === "incho_music") model = taskType === "reference" || taskType === "extend" ? "v3.5" : DEFAULT_MODEL;
  if (!["v3.5", "v4.0"].includes(model)) throw new Error("model must be v3.5 or v4.0");
  if ((taskType === "reference" || taskType === "extend") && model !== "v3.5") throw new Error(taskType + " currently requires model v3.5");
  if (taskType === "instrumental" && model !== "v4.0") throw new Error("instrumental currently requires model v4.0");
  const body = { model: model, n: songCount(incoming) };
  if (action === "MUSIC") body.task_type = taskType;
  if (action !== "EXTEND") {
    const input = Object.assign({}, incoming);
    if (!input.prompt && input.gpt_description_prompt != null) input.prompt = input.gpt_description_prompt;
    const prompt = textField(input, "prompt", model === "v4.0" ? 3000 : 1000, taskType === "instrumental");
    if (prompt) body.prompt = prompt;
  }
  if (taskType !== "instrumental") {
    const lyric = textField(incoming, "lyric", model === "v4.0" ? 5000 : 3000, false);
    if (lyric) body.lyric = lyric;
  }
  if (taskType === "normal" && !trimmed(body.prompt) && !trimmed(body.lyric)) throw new Error("prompt or lyric is required");
  if (taskType === "reference") {
    body.reference_audio = resolveAudio(ctx, incoming.reference_audio, "reference_audio", "reference");
    if (incoming.similarity != null) {
      if (![0.2, 0.8, 1.3, 1.5].includes(incoming.similarity)) throw new Error("similarity must be 0.2, 0.8, 1.3 or 1.5");
      body.similarity = incoming.similarity;
    }
  }
  if (taskType === "extend") {
    body.origin_audio = resolveAudio(ctx, incoming.origin_audio, "origin_audio", "extend");
    if (incoming.extend_at != null) {
      if (typeof incoming.extend_at !== "number" || !Number.isFinite(incoming.extend_at) || incoming.extend_at < 0)
        throw new Error("extend_at must be a non-negative number");
      body.extend_at = incoming.extend_at;
    }
  }
  if (incoming.callback != null) body.callback = textField(incoming, "callback", 0, false);
  return { action: action, body: body, path: taskType === "instrumental" ? "/song/instrumental" : taskType === "extend" ? "/song/extend" : "/song/generate" };
}

// --- submit ------------------------------------------------------------------

export function buildSubmitRequest(ctx) {
  const action = actionName(ctx);
  const incoming = ctx.requestBody || {};
  const request = { url: ctx.baseUrl.replace(/\/+$/, "") + API_PREFIX, method: "POST", headers: authHeaders(ctx), action: action };
  if (action === "LYRIC") {
    request.url += "/lyric/generate";
    request.body = { prompt: textField(incoming, "prompt", 2000, true) };
  } else if (action === "UPLOAD") {
    const file = (ctx.files || []).find(function (item) { return item.ref === incoming.fileRef; });
    validateUpload(file, incoming.upload_type);
    request.url += "/file/upload";
    delete request.headers["Content-Type"];
    request.bodyType = "multipart";
    request.parts = [{ name: "file", fileRef: file.ref, filename: file.filename }, { name: "upload_type", value: incoming.upload_type }];
  } else if (action === "CANCEL") {
    const id = publicTaskId(incoming.id);
    const origin = (ctx.originTasks || []).find(function (task) { return task.taskId === id; });
    if (!origin || !["MUSIC", "INSTRUMENTAL", "EXTEND"].includes(origin.action)) throw new Error("id must identify a song task owned by you");
    request.url += "/task/cancel";
    request.body = { id: origin.upstreamTaskId };
  } else {
    const normalized = validateAndNormalize(ctx);
    request.url += normalized.path;
    request.body = normalized.body;
  }
  return request;
}

function validateUpload(file, uploadType) {
  if (!["reference", "extend"].includes(uploadType)) throw new Error("upload_type must be reference or extend");
  if (!file || file.field !== "file") throw new Error("one audio file in the file field is required");
  if (!/\.(mp3|wav)$/i.test(file.filename)) throw new Error("file must be MP3 or WAV");
  if (!(file.size > 0) || file.size > MAX_UPLOAD) throw new Error("file must be non-empty and at most 10 MB");
}

/** A successful submit returns { id, task_type, choices: [], create_at }. The task id field is `id`. */
export function parseSubmitResponse(ctx, resp) {
  const body = resp.body || {};
  const detail = body.detail;
  if (detail != null && detail !== "") {
    let message = "";
    if (typeof detail === "string") message = trimmed(detail);
    else if (Array.isArray(detail))
      message = detail
        .map(function (item) {
          if (item && typeof item === "object" && !Array.isArray(item) && typeof item.msg === "string") return item.msg;
          return JSON.stringify(item);
        })
        .join("; ");
    else if (typeof detail === "object") message = JSON.stringify(detail);
    else message = String(detail);
    if (trimmed(message)) throw new Error(message);
  }
  const action = actionName(ctx);
  if (action === "LYRIC") {
    if (typeof body.lyric !== "string" || !trimmed(body.lyric)) throw new Error("upstream response did not include lyrics");
    return { taskId: ctx.publicTaskId, taskData: body, immediate: { status: "SUCCESS" } };
  }
  if (action === "CANCEL") {
    if (typeof body.success !== "boolean") throw new Error("upstream response did not include cancellation success");
    return { taskId: ctx.publicTaskId, taskData: body, immediate: { status: "SUCCESS" } };
  }
  const taskId = trimmed(body.id);
  if (!taskId) throw new Error("upstream response did not include a task id");
  if (action === "UPLOAD") return { taskId: taskId, taskData: { id: taskId, upload_type: ctx.requestBody.upload_type }, immediate: { status: "SUCCESS" } };
  // Preserve choices immediately, including song IDs and live pipe URLs.
  return { taskId: taskId, taskData: body };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  const action = actionName(ctx);
  if (action === "LYRIC") return { clips: 1, action: "lyric" };
  if (action === "UPLOAD" || action === "CANCEL") return { clips: 0, action: action.toLowerCase() };
  return { clips: songCount(ctx.requestBody || {}), action: "music" };
}

// --- query -------------------------------------------------------------------

export function buildQueryRequest(ctx) {
  const taskId = trimmed(ctx.taskId || (ctx.params || {}).task_id);
  if (!taskId) throw new Error("task_id is empty");
  return {
    url: ctx.baseUrl.replace(/\/+$/, "") + API_PREFIX + "/task/query?task_id=" + encodeURIComponent(taskId),
    method: "GET",
    headers: authHeaders(ctx),
  };
}

/**
 * One upstream task holds n songs (choices). Task-level status:
 *   all terminal and at least one done -> SUCCESS (partial success still succeeds;
 *                                        failed songs are reported in `reason`)
 *   all terminal and none done         -> FAILURE
 *   otherwise                          -> IN_PROGRESS / QUEUED
 */
export function parseTaskResult(ctx, body) {
  const task = body;
  if (!task || typeof task !== "object" || Array.isArray(task) || !trimmed(task.id) || !Array.isArray(task.choices))
    return { status: "UNKNOWN", reason: "Unrecognized Incho task response" };
  if (ctx.taskId && task.id !== ctx.taskId) return { status: "UNKNOWN", reason: "Incho task id does not match the requested task" };
  const choices = task.choices;
  if (
    choices.some(function (song) {
      return !song || !["pending", "cancelled", "running", "stream", "done", "fail"].includes(trimmed(song.status));
    })
  )
    return { status: "UNKNOWN", reason: "Unrecognized Incho song status" };

  const done = choices.filter(function (s) {
    return trimmed(s.status) === "done";
  });
  const terminal = choices.filter(function (s) {
    return ["done", "fail", "cancelled"].includes(trimmed(s.status));
  });
  const failed = choices.filter(function (s) {
    return ["fail", "cancelled"].includes(trimmed(s.status));
  });

  let status;
  if (choices.length === 0) {
    status = "QUEUED";
  } else if (terminal.length < choices.length) {
    status = done.length > 0 || choices.some(function (s) {
      return ["running", "stream"].includes(trimmed(s.status));
    })
      ? "IN_PROGRESS"
      : "QUEUED";
  } else {
    status = done.length > 0 ? "SUCCESS" : "FAILURE";
  }

  const reason = failed
    .map(function (s) {
      return trimmed(s.error) + (s.error_code ? " (" + s.error_code + ")" : "");
    })
    .filter(Boolean)
    .join("; ");

  return {
    taskId: trimmed(task.id),
    status: status,
    reason: reason,
    progress: choices.length ? Math.round((done.length / choices.length) * 100) + "%" : "0%",
  };
}

// --- artifacts ---------------------------------------------------------------

function songData(data) {
  // Per-task polling persists the entire upstream response, not a parse hook's
  // data field. Continue reading arrays / individual songs from older tasks.
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.choices)) return data.choices;
  return data.status ? [data] : [];
}

function artifactKey(type, song) {
  return type + "-" + utils.hmacSHA256(String(song.id), "new-api:incho:artifact-key");
}

/** Incho produces audio only; there is no cover image artifact. */
export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  const artifacts = [];
  for (const song of songData(task.data)) {
    if (!song || !trimmed(song.id)) continue;
    if (trimmed(song.audio_url)) {
      artifacts.push({ key: artifactKey("audio", song), type: "audio", mimeType: "audio/mpeg" });
    }
  }
  return artifacts;
}

export function buildContentRequest(ctx) {
  const song = songData(ctx.data).find(function (item) {
    if (!item || !trimmed(item.id)) return false;
    return artifactKey("audio", item) === ctx.artifactKey;
  });
  if (!song) throw new Error("the requested audio artifact was not found on this task");
  const url = trimmed(song.audio_url);
  if (!url) throw new Error("the requested audio artifact was not found on this task");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

/** Billed per song that actually completed. Upstream is the source of truth; this only reports. */
export function extractUsageOnComplete(task, taskResult, body) {
  const action = actionName(task);
  if (action === "LYRIC") return { clips: 1, action: "lyric" };
  if (action === "UPLOAD" || action === "CANCEL") return { clips: 0, action: action.toLowerCase() };
  const values = songData(body);
  if (values.length === 0) return null;
  const done = values.filter(function (item) {
    return item && trimmed(item.status) === "done";
  });
  return { clips: done.length, action: "music" };
}

// --- openai_responses --------------------------------------------------------

function escapedAttribute(value) {
  return trimmed(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function responseContent(ctx, task) {
  const songs = task.data && typeof task.data.lyric === "string" && !Array.isArray(task.data.choices) ? [task.data] : songData(task.data);
  const lyrics = [];
  for (const song of songs) {
    if (!song) continue;
    const text = trimmed(song.lyric);
    if (!text) continue;
    const title = trimmed(song.title);
    lyrics.push(title ? title + "\n" + text : text);
  }

  const content = [{ type: "output_text", text: lyrics.join("\n\n") || "Music generation completed.", annotations: [], logprobs: [] }];

  for (const song of songs) {
    if (!song || !trimmed(song.audio_url)) continue;
    const key = artifactKey("audio", song);
    const artifact = ctx && ctx.artifacts && ctx.artifacts[key];
    const url = trimmed(artifact && artifact.url);
    if (!url) throw new Error("audio artifact is unavailable");
    content.push({
      type: "output_text",
      text: '<audio controls src="' + escapedAttribute(url) + '"></audio>',
      annotations: [],
      logprobs: [],
    });
  }
  return content;
}

function responseText(ctx, task) {
  return responseContent(ctx, task)
    .map(function (part) {
      return part.text;
    })
    .join("\n\n");
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const declared = trimmed(ctx.upstreamModel || ctx.model);
      if (!["incho_music", "incho_lyric"].includes(declared)) throw new Error("model must be incho_music, incho_lyric or a channel alias mapped to one of them");
      if (req.input !== undefined && typeof req.input !== "string" && !Array.isArray(req.input)) throw new Error("input must be a string or array");
      if (req.metadata !== undefined && (!req.metadata || typeof req.metadata !== "object" || Array.isArray(req.metadata)))
        throw new Error("metadata must be an object");

      const input = responsesText(req);
      const requestBody = Object.assign({}, req.metadata || {});
      if (!trimmed(requestBody.prompt)) requestBody.prompt = input || trimmed(req.prompt);
      if (declared === "incho_lyric") return submitIntent(requestBody, "LYRIC", ctx.model);
      const action = requestBody.task_type === "extend" ? "EXTEND" : requestBody.task_type === "instrumental" ? "INSTRUMENTAL" : "MUSIC";
      return submitIntent(requestBody, action, ctx.model);
    },

    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const value = Number(String(task.progress || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };

      if (status === "SUCCESS") {
        const text = responseText(ctx, task);
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: text }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE") {
        return {
          events: [{ type: "error", code: "task_failed", message: task.fail_reason || "task failed" }],
          state: state,
          done: true,
        };
      }
      if (previousState && previousState.status === status && previousState.progress === progress) return { events: [], state: state, done: false };

      const event = { type: "progress", message: status.toLowerCase() };
      if (progress !== null) event.progress = progress;
      return { events: [event], state: state, done: false };
    },

    renderFinal: function (ctx, task) {
      return {
        output: [{ type: "message", status: "completed", role: "assistant", content: responseContent(ctx, task) }],
        metadata: { vendor: "incho" },
      };
    },
  },
};

// --- native ------------------------------------------------------------------

function nativeTask(task) {
  return {
    created_at: task.created_at || 0,
    updated_at: task.updated_at || 0,
    task_id: task.task_id || "",
    platform: task.platform || "incho",
    status: task.status || "",
    fail_reason: task.fail_reason || "",
    submit_time: task.created_at || 0,
    finish_time: task.finished_at || 0,
    progress: task.progress || "",
    data: task.data === undefined ? null : task.data,
  };
}

function platformTask(task) {
  const data = task.data || {};
  if (!data.task_type || !["normal", "reference", "extend", "instrumental"].includes(data.task_type))
    throw new Error("task is not a song generation task");
  return Object.assign({}, data, {
    id: task.task_id,
    choices: songData(data).map(function (song) {
      return Object.assign({}, song, { id: task.task_id + ":song:" + song.id });
    }),
  });
}

function queryIds(ctx, key, multiple) {
  const values = (ctx.query || {})[key] || [];
  if (values.length !== 1 || typeof values[0] !== "string") throw new Error(key + " must be supplied exactly once");
  const ids = multiple ? values[0].split(",") : [values[0]];
  if (!ids.length || ids.length > 100) throw new Error("task_ids must contain 1 to 100 ids");
  return ids.map(function (id) { return publicTaskId(id.trim()); });
}

export const native = {
  decodeSubmit: decodeNativeSubmit,
  decodeGenerate: function (ctx) { return submitIntent(jsonBody(ctx), "MUSIC"); },
  decodeInstrumental: function (ctx) { return submitIntent(jsonBody(ctx), "INSTRUMENTAL"); },
  decodeExtend: function (ctx) { return submitIntent(jsonBody(ctx), "EXTEND"); },
  decodeLyric: function (ctx) { return submitIntent(jsonBody(ctx), "LYRIC", "incho_lyric"); },
  decodeUpload: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "multipart") throw new Error("multipart/form-data body required");
    const files = ctx.body.files || [];
    const types = (ctx.body.fields || {}).upload_type || [];
    if (files.length !== 1 || types.length !== 1) throw new Error("one file and one upload_type are required");
    validateUpload(files[0], types[0]);
    return { kind: "submit", model: "incho_upload", action: "UPLOAD", requestBody: { fileRef: files[0].ref, upload_type: types[0] } };
  },
  decodeCancel: function (ctx) {
    const id = publicTaskId(jsonBody(ctx).id);
    return { kind: "submit", model: "incho_cancel", action: "CANCEL", requestBody: { id: id }, originTaskIds: [id] };
  },
  decodeQuery: function (ctx) { return { kind: "query", taskIds: queryIds(ctx, "task_id", false) }; },
  decodeQueries: function (ctx) { return { kind: "query", taskIds: queryIds(ctx, "task_ids", true) }; },
  renderPlatformTask: function (ctx, task) { return platformTask(task); },
  renderPlatformQuery: function (ctx, tasks) { return platformTask(tasks[0]); },
  renderPlatformQueries: function (ctx, tasks) { return { tasks: tasks.map(platformTask) }; },
  renderImmediate: function (ctx, task) { return task.data; },
  renderUpload: function (ctx, task) { return { id: task.task_id }; },
  renderSubmit: function (ctx, task) {
    return { code: "success", message: "", data: String(task.task_id || "") };
  },
  renderTask: function (ctx, task) {
    return { code: "success", message: "", data: nativeTask(task) };
  },
  error: function (ctx, error) {
    if (String(ctx.path || "").indexOf("/incho/api/v1/") === 0) return { detail: error.message };
    return { code: error.code, message: error.message, data: null };
  },
};
