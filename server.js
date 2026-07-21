const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const port = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, 'public');
const customDir = path.join(__dirname, 'custom');
const manifestPath = path.join(customDir, 'manifest.json');
const privateDir = path.join(__dirname, 'private-sounds');
const maxAudioBytes = 25 * 1024 * 1024;
const maxIconBytes = 150 * 1024;
const rooms = new Map();
const roomRegistry = new Map();
fs.mkdirSync(customDir, { recursive: true });
fs.mkdirSync(privateDir, { recursive: true });

function loadAssets() {
  try { return new Map(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).map(asset => [asset.id, asset])); } catch { return new Map(); }
}
const assets = loadAssets();
function saveAssets() { fs.writeFileSync(manifestPath, JSON.stringify([...assets.values()], null, 2)); }

// Each private sound gets its own folder: private-sounds/<id>/meta.json + audio.<ext> + icon.<ext> (if custom)
function privateFolder(id) { return path.join(privateDir, id); }
function privateMetaPath(id) { return path.join(privateFolder(id), 'meta.json'); }
function loadPrivateSounds() {
  const map = new Map();
  for (const id of fs.readdirSync(privateDir)) {
    try { map.set(id, JSON.parse(fs.readFileSync(privateMetaPath(id), 'utf8'))); } catch {}
  }
  return map;
}
const privateSounds = loadPrivateSounds();
function savePrivateMeta(meta) { fs.writeFileSync(privateMetaPath(meta.id), JSON.stringify(meta, null, 2)); }

function roomClients(room) { if (!rooms.has(room)) rooms.set(room, new Set()); return rooms.get(room); }
function registryFor(room) { if (!roomRegistry.has(room)) roomRegistry.set(room, new Map()); return roomRegistry.get(room); }
function writeEvent(client, payload) { client.write(`data: ${JSON.stringify(payload)}\n\n`); }
function sendEvent(room, payload) { for (const client of roomClients(room)) writeEvent(client, payload); }
function sendJson(response, status, body) { const content = JSON.stringify(body); response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(content), 'Cache-Control': 'no-store', Connection: 'close' }); response.end(content); }
function validRoom(value) { return typeof value === 'string' && /^[a-z0-9-]{3,32}$/i.test(value); }
function validAsset(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value); }
function validStockIcon(value) { return typeof value === 'string' && value.length > 0 && value.length <= 8 && !/[<>]/.test(value); }
function extensionFor(mimeType, fileName) {
  const candidate = path.extname(fileName || '').toLowerCase();
  if (/^\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(candidate)) return candidate;
  return ({ 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/webm': '.webm' })[mimeType] || '.audio';
}
function iconExtensionFor(mimeType) { return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[mimeType] || null; }
function iconPayload(meta) { return meta.icon.type === 'custom' ? { type: 'custom', url: `/api/private-sounds/${meta.id}/icon` } : { type: 'stock', value: meta.icon.value }; }

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let received = 0;
    request.on('data', chunk => { received += chunk.length; if (received > maxBytes) { reject(new Error('too-large')); request.destroy(); return; } chunks.push(chunk); });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function serveFile(response, requestedPath) {
  const filePath = requestedPath === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, requestedPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(publicDir))) return sendJson(response, 403, { error: 'Forbidden' });
  fs.readFile(resolved, (error, content) => {
    if (error) return sendJson(response, 404, { error: 'Not found' });
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(resolved)] || 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-store, max-age=0', Connection: 'close' });
    response.end(content);
  });
}

function serveFromDisk(request, response, filePath, mimeType, downloadName) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return sendJson(response, 404, { error: 'File not found.' });
    const range = request.headers.range;
    const headers = { 'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (downloadName) headers['Content-Disposition'] = `inline; filename="${downloadName.replace(/[^\w.-]/g, '_')}"`;
    if (!range) { response.writeHead(200, { ...headers, 'Content-Length': stats.size }); return fs.createReadStream(filePath).pipe(response); }
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (!match) return sendJson(response, 416, { error: 'Invalid range.' });
    const start = Number(match[1]); const end = match[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
    if (start >= stats.size || end < start) return sendJson(response, 416, { error: 'Range not satisfiable.' });
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stats.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(filePath, { start, end }).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const eventMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]{3,32})\/events$/i);
  const audioMatch = url.pathname.match(/^\/api\/audio\/([a-f0-9-]{36})$/i);
  const privateIconMatch = url.pathname.match(/^\/api\/private-sounds\/([a-f0-9-]{36})\/icon$/i);
  const privateAudioMatch = url.pathname.match(/^\/api\/private-sounds\/([a-f0-9-]{36})\/audio$/i);

  if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true });
  if (request.method === 'GET' && audioMatch) { const asset = assets.get(audioMatch[1]); return asset ? serveFromDisk(request, response, path.join(customDir, asset.file), asset.mimeType, asset.name) : sendJson(response, 404, { error: 'Unknown audio.' }); }

  if (request.method === 'GET' && privateAudioMatch) {
    const meta = privateSounds.get(privateAudioMatch[1]);
    if (!meta) return sendJson(response, 404, { error: 'Unknown sound.' });
    return serveFromDisk(request, response, path.join(privateFolder(meta.id), meta.audio.file), meta.audio.mimeType, meta.name);
  }
  if (request.method === 'GET' && privateIconMatch) {
    const meta = privateSounds.get(privateIconMatch[1]);
    if (!meta || meta.icon.type !== 'custom') return sendJson(response, 404, { error: 'No custom icon.' });
    return serveFromDisk(request, response, path.join(privateFolder(meta.id), meta.icon.file), meta.icon.mimeType, null);
  }

  if (request.method === 'POST' && url.pathname === '/api/audio') {
    const mimeType = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
    const length = Number(request.headers['content-length'] || 0);
    if (!mimeType.startsWith('audio/') || length > maxAudioBytes) return sendJson(response, 400, { error: 'Upload an audio file no larger than 25 MB.' });
    readBody(request, maxAudioBytes).then(buffer => {
      if (!buffer.length) return sendJson(response, 400, { error: 'No audio was received.' });
      const name = decodeURIComponent(String(request.headers['x-audio-name'] || 'Custom sound')).slice(0, 80).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const id = crypto.randomUUID(); const file = `${id}${extensionFor(mimeType, name)}`;
      fs.writeFileSync(path.join(customDir, file), buffer);
      const asset = { id, file, name, mimeType, uploadedAt: Date.now() }; assets.set(id, asset); saveAssets();
      return sendJson(response, 201, { id, name: asset.name, mimeType });
    }).catch(() => sendJson(response, 400, { error: 'Upload an audio file no larger than 25 MB.' }));
    return;
  }

  // Create a private sound: folder with meta.json + audio.<ext>, optionally followed by a POST .../icon
  if (request.method === 'POST' && url.pathname === '/api/private-sounds') {
    const mimeType = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
    const length = Number(request.headers['content-length'] || 0);
    const room = String(request.headers['x-room'] || '').toLowerCase();
    const name = decodeURIComponent(String(request.headers['x-sound-name'] || '')).trim().slice(0, 80);
    const iconHeader = decodeURIComponent(String(request.headers['x-icon'] || ''));
    if (!validRoom(room)) return sendJson(response, 400, { error: 'Join a room before adding a sound.' });
    if (!name) return sendJson(response, 400, { error: 'Give your sound a name.' });
    if (!mimeType.startsWith('audio/') || length > maxAudioBytes) return sendJson(response, 400, { error: 'Upload an audio file no larger than 25 MB.' });
    const wantsCustomIcon = iconHeader === 'custom';
    if (!wantsCustomIcon && !validStockIcon(iconHeader)) return sendJson(response, 400, { error: 'Choose a valid icon.' });
    readBody(request, maxAudioBytes).then(buffer => {
      if (!buffer.length) return sendJson(response, 400, { error: 'No audio was received.' });
      const id = crypto.randomUUID();
      fs.mkdirSync(privateFolder(id), { recursive: true });
      const audioFile = `audio${extensionFor(mimeType, name)}`;
      fs.writeFileSync(path.join(privateFolder(id), audioFile), buffer);
      const meta = {
        id, room, name,
        icon: wantsCustomIcon ? { type: 'custom', file: null, mimeType: null } : { type: 'stock', value: iconHeader },
        audio: { file: audioFile, mimeType },
        createdAt: Date.now(),
      };
      privateSounds.set(id, meta); savePrivateMeta(meta);
      return sendJson(response, 201, { id, name, icon: iconPayload(meta), audioUrl: `/api/private-sounds/${id}/audio` });
    }).catch(() => sendJson(response, 400, { error: 'Upload an audio file no larger than 25 MB.' }));
    return;
  }

  // Attach a custom icon to a private sound created above
  if (request.method === 'POST' && privateIconMatch) {
    const meta = privateSounds.get(privateIconMatch[1]);
    if (!meta) return sendJson(response, 404, { error: 'Unknown sound.' });
    const mimeType = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
    const length = Number(request.headers['content-length'] || 0);
    const ext = iconExtensionFor(mimeType);
    if (!ext || length > maxIconBytes) return sendJson(response, 400, { error: 'Use a PNG, JPG, WebP, or GIF icon up to 150 KB.' });
    readBody(request, maxIconBytes).then(buffer => {
      if (!buffer.length) return sendJson(response, 400, { error: 'No icon was received.' });
      const iconFile = `icon${ext}`;
      fs.writeFileSync(path.join(privateFolder(meta.id), iconFile), buffer);
      meta.icon = { type: 'custom', file: iconFile, mimeType }; savePrivateMeta(meta);
      return sendJson(response, 200, { iconUrl: `/api/private-sounds/${meta.id}/icon` });
    }).catch(() => sendJson(response, 400, { error: 'Use a PNG, JPG, WebP, or GIF icon up to 150 KB.' }));
    return;
  }

  if (request.method === 'GET' && eventMatch) {
    const room = eventMatch[1].toLowerCase();
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); response.write('retry: 2000\n\n');
    const clients = roomClients(room); clients.add(response);
    for (const payload of registryFor(room).values()) writeEvent(response, payload);
    request.on('close', () => { clients.delete(response); if (clients.size === 0) rooms.delete(room); }); return;
  }

  if (request.method === 'POST' && eventMatch) {
    const room = eventMatch[1].toLowerCase(); let rawBody = '';
    request.on('data', chunk => { rawBody += chunk; if (rawBody.length > 20_000) request.destroy(); });
    request.on('end', () => {
      try {
        const event = JSON.parse(rawBody || '{}');
        const custom = event.sound === 'custom' && validAsset(event.audioId) && assets.has(event.audioId);
        const privateRegister = event.type === 'private-register' && validAsset(event.privateId) && privateSounds.has(event.privateId) && privateSounds.get(event.privateId).room === room;
        const privateTrigger = event.type === 'private-trigger' && validAsset(event.privateId) && privateSounds.has(event.privateId) && privateSounds.get(event.privateId).room === room;
        if (!validRoom(room) || (!custom && !privateRegister && !privateTrigger)) return sendJson(response, 400, { error: 'Invalid sound event.' });
        let payload;
        if (custom) { payload = { sound: 'custom', audioId: event.audioId, name: assets.get(event.audioId).name, mimeType: assets.get(event.audioId).mimeType, sentAt: Date.now() }; }
        else if (privateRegister) { const meta = privateSounds.get(event.privateId); payload = { type: 'private-register', privateId: meta.id, name: meta.name, icon: iconPayload(meta), sentAt: Date.now() }; registryFor(room).set(meta.id, payload); }
        else { payload = { type: 'private-trigger', privateId: event.privateId, sentAt: Date.now() }; }
        sendEvent(room, payload); return sendJson(response, 202, { ok: true });
      } catch { return sendJson(response, 400, { error: 'Invalid JSON.' }); }
    }); return;
  }
  if (request.method === 'GET') return serveFile(response, decodeURIComponent(url.pathname));
  return sendJson(response, 405, { error: 'Method not allowed.' });
});

server.keepAliveTimeout = 5_000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Soundboard is running at http://localhost:${port}`);
  for (const [name, network] of Object.entries(os.networkInterfaces())) for (const address of network || []) if (address.family === 'IPv4' && !address.internal) console.log(`${name}: http://${address.address}:${port}`);
});