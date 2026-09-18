import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Read as an ES module on Node versions that do not infer .js module syntax.
globalThis.utils = { hmacSHA256: (message, secret) => createHmac('sha256', secret).update(message).digest('hex') };
const source = readFileSync(new URL('../../plugins/tasks/incho/1.1.0/plugin.js', import.meta.url), 'utf8');
const p = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const base = 'https://open.yinchaoyongxian.com';
const ctx = (requestBody, action = 'MUSIC', extra = {}) => ({ baseUrl: base, apiKey: 'test-key', model: 'incho_music', upstreamModel: 'incho_music', publicTaskId: 'task_new', requestBody, action, ...extra });
const json = value => ({ body: { kind: 'json', value } });
const file = { ref: 'request_file:file', field: 'file', filename: 'reference.mp3', mimeType: 'audio/mpeg', size: 1000 };
const audio = (type, content) => ({ audio_type: type, audio_content: content });
const task = { id: 'vendor-task', task_type: 'normal', create_at: 1, choices: [
  { id: 'song-a', status: 'done', title: 'Title', lyric: 'Lyrics', audio_url: 'https://cdn.example/a.mp3', pipe_url: 'https://cdn.example/pipe' },
  { id: 'song-b', status: 'cancelled', error: 'Cancelled', error_code: 9 },
] };

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('all eight JSON API paths preserve upstream suffixes; legacy routes remain', () => {
  const expected = ['POST /song/generate', 'POST /song/extend', 'POST /song/instrumental', 'POST /lyric/generate', 'POST /file/upload', 'POST /task/cancel', 'GET /task/query', 'GET /task/querys'];
  for (const endpoint of expected) {
    const [method, suffix] = endpoint.split(' ');
    assert.ok(p.meta.routes.some(r => r.method === method && r.path === '/incho/api/v1' + suffix));
  }
  assert.ok(p.meta.routes.some(r => r.path === '/incho/submit/:action'));
  assert.ok(p.meta.routes.some(r => r.path === '/incho/fetch/:task_id'));
  assert.ok(!p.meta.routes.some(r => r.path.includes('/song/stream')));
  assert.deepEqual(p.meta.protocols[0].models, ['incho_music', 'incho_lyric']);
});

test('normal generation preserves vendor fields, Unicode limits and mapping precedence', () => {
  const body = freeze({ model: 'v4.0', task_type: 'normal', prompt: '🎵'.repeat(3000), lyric: '词'.repeat(5000), callback: 'https://example.com/callback', n: 1 });
  const request = p.buildSubmitRequest(ctx(body));
  assert.equal(request.url, base + '/api/v1/song/generate');
  assert.deepEqual(request.body, body);
  assert.equal(request.headers.Authorization, 'Bearer test-key');
  assert.equal(request.headers['X-Incho-Source'], 'plugins');
  assert.equal(request.headers['User-Agent'], 'incho-newapi-plugin/1.1.0');
  assert.equal(p.buildSubmitRequest(ctx({ prompt: 'pop' }, 'MUSIC', { baseUrl: base + '/' })).url, request.url);
  assert.equal(p.buildSubmitRequest(ctx({ model: 'v4.0', prompt: 'pop' }, 'MUSIC', { upstreamModel: 'v3.5' })).body.model, 'v3.5');
  assert.equal(p.buildSubmitRequest(ctx({ prompt: 'pop' }, 'MUSIC', { model: 'alias', upstreamModel: 'incho_music' })).model, undefined);
  assert.throws(() => p.buildSubmitRequest(ctx({ model: 'v3.5', prompt: '🎵'.repeat(1001) })), /1000 characters/);
  assert.throws(() => p.buildSubmitRequest(ctx({ prompt: '🎵'.repeat(3001) })), /3000 characters/);
  assert.throws(() => p.buildSubmitRequest(ctx({ lyric: '词'.repeat(5001) })), /5000 characters/);
  assert.throws(() => p.buildSubmitRequest(ctx({ model: 'v3.5', lyric: '词'.repeat(3001) })), /3000 characters/);
});

test('strict counts, model/mode combinations and required input', () => {
  for (const n of [0, 3, -1, true, {}, [], 1.5, '']) assert.throws(() => p.buildSubmitRequest(ctx({ prompt: 'pop', n })), /n must/);
  assert.equal(p.buildSubmitRequest(ctx({ gpt_description_prompt: 'pop', n: '1' })).body.n, 1);
  assert.equal(p.buildSubmitRequest(ctx({ lyric: 'custom' })).body.n, 2);
  assert.throws(() => p.buildSubmitRequest(ctx({ prompt: true })), /string/);
  assert.throws(() => p.buildSubmitRequest(ctx({})), /required/);
  assert.throws(() => p.buildSubmitRequest(ctx({ prompt: 'pop', task_type: 'instrumental' })), /endpoint/);
  assert.throws(() => p.buildSubmitRequest(ctx({ prompt: 'pop', model: 'v3.5' }, 'INSTRUMENTAL')), /v4.0/);
  assert.throws(() => p.buildSubmitRequest(ctx({ task_type: 'reference', model: 'v4.0' })), /v3.5/);
  assert.throws(() => p.buildSubmitRequest(ctx({ task_type: 'normal', prompt: 'pop' }, 'EXTEND')), /does not match/);
});

test('instrumental uses its own endpoint and fields', () => {
  const intent = p.native.decodeInstrumental(json({ prompt: 'piano', callback: 'https://example.com/cb', n: 1 }));
  const request = p.buildSubmitRequest(ctx(intent.requestBody, intent.action));
  assert.equal(request.url, base + '/api/v1/song/instrumental');
  assert.deepEqual(request.body, { model: 'v4.0', prompt: 'piano', callback: 'https://example.com/cb', n: 1 });
  assert.throws(() => p.buildSubmitRequest(ctx({ lyric: 'not a prompt' }, 'INSTRUMENTAL')), /prompt is required/);
});

test('reference audio URLs, similarity and callback survive without requiring prompt', () => {
  for (const similarity of [0.2, 0.8, 1.3, 1.5]) {
    const body = { task_type: 'reference', reference_audio: audio('audio_url', 'https://example.com/a.mp3'), similarity, callback: 'https://example.com/cb' };
    const intent = p.native.decodeGenerate(json(body));
    assert.equal(intent.originTaskIds, undefined);
    assert.deepEqual(p.buildSubmitRequest(ctx(body)).body, { ...body, model: 'v3.5', n: 2 });
  }
  assert.throws(() => p.buildSubmitRequest(ctx({ task_type: 'reference', reference_audio: audio('audio_url', 'https://example.com/a.mp3'), similarity: '0.8' })), /similarity/);
  assert.throws(() => p.native.decodeGenerate(json({ task_type: 'reference' })), /reference_audio/);
});

test('upload streams the scoped multipart ref, completes immediately and returns a public ID', () => {
  const body = freeze({ kind: 'multipart', fields: { upload_type: ['reference'] }, files: [file] });
  const intent = p.native.decodeUpload({ body });
  assert.equal(intent.model, 'incho_upload');
  const driver = ctx(intent.requestBody, intent.action, { files: [file] });
  const request = p.buildSubmitRequest(driver);
  assert.equal(request.url, base + '/api/v1/file/upload');
  assert.equal(request.headers['Content-Type'], undefined);
  assert.equal(request.bodyType, 'multipart');
  assert.deepEqual(request.parts, [{ name: 'file', fileRef: file.ref, filename: file.filename }, { name: 'upload_type', value: 'reference' }]);
  const result = p.parseSubmitResponse(driver, { body: { id: 'vendor-upload' } });
  assert.equal(result.immediate.status, 'SUCCESS');
  assert.deepEqual(result.taskData, { id: 'vendor-upload', upload_type: 'reference' });
  assert.deepEqual(p.native.renderUpload({}, { task_id: 'task_upload', data: result.taskData }), { id: 'task_upload' });
});

test('upload rejects extra files, duplicate type, unsupported formats and excess size', () => {
  const upload = (files, types = ['reference']) => p.native.decodeUpload({ body: { kind: 'multipart', files, fields: { upload_type: types } } });
  assert.throws(() => upload([file, file]), /one file/);
  assert.throws(() => upload([file], ['reference', 'extend']), /one file/);
  assert.throws(() => upload([file], ['other']), /upload_type/);
  for (const patch of [{ size: 0 }, { size: 10485761 }, { filename: 'audio.exe' }, { field: 'wrong' }]) assert.throws(() => upload([{ ...file, ...patch }]));
  assert.equal(upload([{ ...file, filename: 'a.WAV', size: 10485760 }], ['extend']).action, 'UPLOAD');
});

test('uploaded audio resolves only through owned origin tasks and matching upload type', () => {
  const body = { task_type: 'reference', reference_audio: audio('upload_id', 'task_upload') };
  const intent = p.native.decodeGenerate(json(body));
  assert.deepEqual(intent.originTaskIds, ['task_upload']);
  const origin = { taskId: 'task_upload', upstreamTaskId: 'vendor-upload', action: 'UPLOAD', status: 'SUCCESS', data: { upload_type: 'reference' } };
  assert.equal(p.buildSubmitRequest(ctx(body, 'MUSIC', { originTasks: [origin] })).body.reference_audio.audio_content, 'vendor-upload');
  assert.throws(() => p.buildSubmitRequest(ctx(body)), /not resolved/);
  assert.throws(() => p.buildSubmitRequest(ctx(body, 'MUSIC', { originTasks: [{ ...origin, status: 'FAILURE' }] })), /successful/);
  assert.throws(() => p.buildSubmitRequest(ctx(body, 'MUSIC', { originTasks: [{ ...origin, data: { upload_type: 'extend' } }] })), /reference upload/);
  assert.throws(() => p.native.decodeGenerate(json({ ...body, reference_audio: audio('upload_id', 'vendor-upload') })), /gateway/);
});

test('song IDs round-trip into extend independently of choice ordering', () => {
  const view = p.native.renderPlatformTask({}, { task_id: 'task_origin', data: freeze(task) });
  assert.equal(view.id, 'task_origin');
  assert.equal(view.choices[0].id, 'task_origin:song:song-a');
  assert.equal(view.choices[0].pipe_url, task.choices[0].pipe_url);
  const body = { origin_audio: audio('audio_id', view.choices[0].id), extend_at: 0, callback: 'https://example.com/cb', lyric: 'more' };
  const intent = p.native.decodeExtend(json(body));
  assert.deepEqual(intent.originTaskIds, ['task_origin']);
  const origin = { taskId: 'task_origin', upstreamTaskId: task.id, action: 'MUSIC', status: 'SUCCESS', data: { ...task, choices: [...task.choices].reverse() } };
  const request = p.buildSubmitRequest(ctx(body, intent.action, { originTasks: [origin] }));
  assert.equal(request.url, base + '/api/v1/song/extend');
  assert.deepEqual(request.body, { model: 'v3.5', n: 2, origin_audio: audio('audio_id', 'song-a'), extend_at: 0, lyric: 'more', callback: body.callback });
  assert.equal(task.choices[0].id, 'song-a');
  assert.throws(() => p.buildSubmitRequest(ctx({ ...body, origin_audio: audio('audio_id', 'task_origin:song:other-song') }, 'EXTEND', { originTasks: [origin] })), /completed song/);
  assert.throws(() => p.buildSubmitRequest(ctx({ ...body, origin_audio: audio('audio_id', 'task_origin:song:song-b') }, 'EXTEND', { originTasks: [origin] })), /completed song/);
});

test('extend supports URLs and uploaded origins, omits absent extend_at', () => {
  const body = { origin_audio: audio('audio_url', 'https://example.com/a.wav') };
  const request = p.buildSubmitRequest(ctx(body, 'EXTEND'));
  assert.equal(request.body.extend_at, undefined);
  for (const extend_at of [-1, '0', true, Infinity]) assert.throws(() => p.buildSubmitRequest(ctx({ ...body, extend_at }, 'EXTEND')), /extend_at/);
  const upload = { taskId: 'task_upload', upstreamTaskId: 'vendor-upload', action: 'UPLOAD', status: 'SUCCESS', data: { upload_type: 'extend' } };
  assert.equal(p.buildSubmitRequest(ctx({ origin_audio: audio('upload_id', 'task_upload') }, 'EXTEND', { originTasks: [upload] })).body.origin_audio.audio_content, 'vendor-upload');
});

test('lyrics complete synchronously with independent billing and Responses text', () => {
  const intent = p.native.decodeLyric(json({ prompt: '🎵'.repeat(2000) }));
  assert.equal(intent.model, 'incho_lyric');
  const driver = ctx(intent.requestBody, intent.action, { model: intent.model, upstreamModel: intent.model });
  assert.equal(p.buildSubmitRequest(driver).url, base + '/api/v1/lyric/generate');
  assert.throws(() => p.buildSubmitRequest(ctx({ prompt: '🎵'.repeat(2001) }, 'LYRIC')), /2000/);
  const data = { title: 'Title', lyric: '[VERSE]\nLyrics' };
  const result = p.parseSubmitResponse(driver, { body: data });
  assert.equal(result.immediate.status, 'SUCCESS');
  assert.deepEqual(p.native.renderImmediate({}, { data: result.taskData }), data);
  assert.deepEqual(p.extractUsage(driver), { clips: 1, action: 'lyric' });
  assert.deepEqual(p.extractUsageOnComplete({ action: 'LYRIC' }, {}, data), { clips: 1, action: 'lyric' });
  assert.equal(p.protocols.openai_responses.renderFinal({}, { data }).output[0].content[0].text, 'Title\n[VERSE]\nLyrics');
  assert.throws(() => p.parseSubmitResponse(driver, { body: {} }), /lyrics/);
});

test('cancel pins the owned song task; preserves upstream success and rejection responses', () => {
  const intent = p.native.decodeCancel(json({ id: 'task_origin' }));
  assert.deepEqual(intent.originTaskIds, ['task_origin']);
  assert.equal(intent.model, 'incho_cancel');
  const driver = ctx(intent.requestBody, intent.action, { originTasks: [{ taskId: 'task_origin', upstreamTaskId: 'vendor-task', action: 'MUSIC' }] });
  assert.deepEqual(p.buildSubmitRequest(driver).body, { id: 'vendor-task' });
  assert.equal(p.buildSubmitRequest(driver).url, base + '/api/v1/task/cancel');
  for (const success of [true, false]) {
    const body = { success, message: success ? '' : 'Already completed' };
    const result = p.parseSubmitResponse(driver, { body });
    assert.deepEqual(p.native.renderImmediate({}, { data: result.taskData }), body);
    assert.equal(result.immediate.status, 'SUCCESS');
  }
  assert.throws(() => p.buildSubmitRequest(ctx(intent.requestBody, 'CANCEL')), /owned by you/);
  assert.throws(() => p.native.decodeCancel(json({ id: 'vendor-task' })), /gateway/);
  assert.throws(() => p.buildSubmitRequest(ctx(intent.requestBody, 'CANCEL', { originTasks: [{ taskId: 'task_origin', action: 'UPLOAD' }] })), /song task/);
  for (const action of ['UPLOAD', 'CANCEL']) {
    assert.deepEqual(p.extractUsage(ctx({}, action)), { clips: 0, action: action.toLowerCase() });
    assert.deepEqual(p.extractUsageOnComplete({ action }, {}, {}), { clips: 0, action: action.toLowerCase() });
  }
});

test('single and batch query use owned public IDs and native provider envelopes', () => {
  assert.deepEqual(p.native.decodeQuery({ query: { task_id: ['task_origin'] } }), { kind: 'query', taskIds: ['task_origin'] });
  assert.deepEqual(p.native.decodeQueries({ query: { task_ids: ['task_a, task_b'] } }), { kind: 'query', taskIds: ['task_a', 'task_b'] });
  for (const query of [{}, { task_ids: [''] }, { task_ids: ['task_a,'] }, { task_ids: ['task_a', 'task_b'] }, { task_ids: [Array(101).fill('task_a').join(',')] }]) assert.throws(() => p.native.decodeQueries({ query }));
  const view = { task_id: 'task_origin', data: task };
  assert.equal(p.native.renderPlatformQuery({}, [view]).id, 'task_origin');
  assert.equal(p.native.renderPlatformQueries({}, [view]).tasks[0].id, 'task_origin');
  assert.throws(() => p.native.renderPlatformQuery({}, [{ task_id: 'task_upload', data: { id: 'task_upload' } }]), /song generation/);
});

test('polling and settlement handle partial success, cancellation and missing audio URL', () => {
  assert.equal(p.parseTaskResult({ taskId: task.id }, task).status, 'SUCCESS');
  assert.deepEqual(p.extractUsageOnComplete({ action: 'MUSIC' }, {}, task), { clips: 1, action: 'music' });
  assert.deepEqual(p.extractUsageOnComplete({ action: 'MUSIC' }, {}, { choices: [{ status: 'done' }] }), { clips: 1, action: 'music' });
  assert.equal(p.parseTaskResult({}, { ...task, choices: [{ status: 'cancelled' }] }).status, 'FAILURE');
  assert.equal(p.parseTaskResult({}, { ...task, choices: [{ status: 'done' }, { status: 'pending' }] }).status, 'IN_PROGRESS');
  assert.equal(p.parseTaskResult({}, { ...task, choices: [{ status: 'stream' }] }).status, 'IN_PROGRESS');
  assert.equal(p.parseTaskResult({}, { ...task, choices: [] }).status, 'QUEUED');
  assert.equal(p.parseTaskResult({}, { ...task, choices: [{ status: 'unknown' }] }).status, 'UNKNOWN');
  assert.equal(p.parseTaskResult({ taskId: 'wrong' }, task).status, 'UNKNOWN');
  assert.equal(p.buildQueryRequest({ baseUrl: base + '/', apiKey: 'test', taskId: 'vendor?task' }).url, base + '/api/v1/task/query?task_id=vendor%3Ftask');
});

test('Responses accepts all music modes and lyrics while keeping the client alias', () => {
  const decode = (model, metadata, input = '') => p.protocols.openai_responses.decodeRequest({ ...json({ input, metadata }), model: 'client-alias', upstreamModel: model });
  for (const [task_type, action] of [['normal', 'MUSIC'], ['instrumental', 'INSTRUMENTAL'], ['reference', 'MUSIC'], ['extend', 'EXTEND']]) {
    const metadata = { task_type, model: task_type === 'reference' || task_type === 'extend' ? 'v3.5' : 'v4.0' };
    if (task_type === 'reference') metadata.reference_audio = audio('audio_url', 'https://example.com/a.mp3');
    if (task_type === 'extend') metadata.origin_audio = audio('audio_url', 'https://example.com/a.mp3');
    const intent = decode('incho_music', metadata, 'pop');
    assert.equal(intent.model, 'client-alias');
    assert.equal(intent.action, action);
    assert.ok(p.buildSubmitRequest(ctx(intent.requestBody, intent.action, { model: intent.model })).url.startsWith(base));
  }
  assert.equal(decode('incho_lyric', {}, 'summer').action, 'LYRIC');
  assert.throws(() => decode('incho_upload', {}), /model must/);
  assert.throws(() => p.protocols.openai_responses.decodeRequest({ ...json({ metadata: [] }), model: 'incho_music' }), /metadata/);
});

test('legacy endpoints retain envelopes, errors and audio artifacts', () => {
  assert.equal(p.native.decodeSubmit({ ...json({ prompt: 'pop' }), params: { action: 'music' } }).action, 'MUSIC');
  assert.throws(() => p.native.decodeSubmit({ ...json({ prompt: 'pop' }), params: { action: 'other' } }), /action/);
  assert.deepEqual(p.native.renderSubmit({}, { task_id: 'task_new' }), { code: 'success', message: '', data: 'task_new' });
  assert.equal(p.native.renderTask({}, { task_id: 'task_new', data: task }).data.data, task);
  assert.deepEqual(p.native.error({ path: '/incho/api/v1/task/query' }, { code: 'bad', message: 'bad request' }), { detail: 'bad request' });
  assert.deepEqual(p.native.error({ path: '/incho/fetch/task_new' }, { code: 'bad', message: 'bad request' }), { code: 'bad', message: 'bad request', data: null });
  assert.throws(() => p.parseSubmitResponse(ctx({}), { body: { detail: [{ msg: 'invalid field' }] } }), /invalid field/);
  const artifacts = p.listArtifacts({ status: 'SUCCESS', data: task });
  assert.equal(artifacts.length, 1);
  const request = p.buildContentRequest({ data: task, artifactKey: artifacts[0].key, clientRequest: { method: 'GET' } });
  assert.equal(request.credentialless, true);
  assert.equal(request.headers, undefined);
  assert.equal(request.url, task.choices[0].audio_url);
  const final = p.protocols.openai_responses.renderFinal({ artifacts: { [artifacts[0].key]: { url: '/gateway/signed/audio' } } }, { data: task });
  assert.ok(final.output[0].content[1].text.includes('/gateway/signed/audio'));
  assert.ok(!JSON.stringify(final).includes('cdn.example'));
});
