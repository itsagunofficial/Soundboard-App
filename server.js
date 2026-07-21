const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const port = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, 'public');
const customDir = path.join(__dirname, 'custom');
const manifestPath = path.join(customDir, 'manifest.json');
const maxAudioBytes = 25 * 1024 * 1024;
const rooms = new Map();
fs.mkdirSync(customDir, { recursive: true });

function loadAssets() {
  try { return new Map(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).map(asset => [asset.id, asset])); } catch { return new Map(); }
}
const assets = loadAssets();
function saveAssets() { fs.writeFileSync(manifestPath, JSON.stringify([...assets.values()], null, 2)); }
function roomClients(room) { if (!rooms.has(room)) rooms.set(room, new Set()); return rooms.get(room); }
function sendEvent(room, payload) { const message = `data: ${JSON.stringify(payload)}\n\n`; for (const client of roomClients(room)) client.write(message); }
function sendJson(response, status, body) { const content = JSON.stringify(body); response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(content), 'Cache-Control': 'no-store', Connection: 'close' }); response.end(content); }
function validRoom(value) { return typeof value === 'string' && /^[a-z0-9-]{3,32}$/i.test(value); }
function validAsset(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value); }
function validIcon(value) { return typeof value === 'string' && value.length > 0 && value.length <= 200_000 && !/[<>]/.test(value) && (!value.startsWith('data:') || /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value)); }
function extensionFor(mimeType, fileName) {
  const candidate = path.extname(fileName || '').toLowerCase();
  if (/^\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(candidate)) return candidate;
  return ({ 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/webm': '.webm' })[mimeType] || '.audio';
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

function serveAudio(request, response, asset) {
  const filePath = path.join(customDir, asset.file);
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return sendJson(response, 404, { error: 'Audio file not found.' });
    const range = request.headers.range;
    const headers = { 'Content-Type': asset.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="${asset.name.replace(/[^\w.-]/g, '_')}"` };
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
  if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true });
  if (request.method === 'GET' && audioMatch) { const asset = assets.get(audioMatch[1]); return asset ? serveAudio(request, response, asset) : sendJson(response, 404, { error: 'Unknown audio.' }); }

  if (request.method === 'POST' && url.pathname === '/api/audio') {
    const mimeType = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
    const length = Number(request.headers['content-length'] || 0);
    if (!mimeType.startsWith('audio/') || length > maxAudioBytes) return sendJson(response, 400, { error: 'Upload an audio file no larger than 25 MB.' });
    const chunks = []; let received = 0;
    request.on('data', chunk => { received += chunk.length; if (received > maxAudioBytes) return request.destroy(); chunks.push(chunk); });
    request.on('end', () => {
      if (!received) return sendJson(response, 400, { error: 'No audio was received.' });
      const name = decodeURIComponent(String(request.headers['x-audio-name'] || 'Custom sound')).slice(0, 80).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const id = crypto.randomUUID(); const file = `${id}${extensionFor(mimeType, name)}`;
      fs.writeFileSync(path.join(customDir, file), Buffer.concat(chunks));
      const asset = { id, file, name, mimeType, uploadedAt: Date.now() }; assets.set(id, asset); saveAssets();
      return sendJson(response, 201, { id, name: asset.name, mimeType });
    });
    return;
  }

  if (request.method === 'GET' && eventMatch) {
    const room = eventMatch[1].toLowerCase();
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); response.write('retry: 2000\n\n');
    const clients = roomClients(room); clients.add(response);
    request.on('close', () => { clients.delete(response); if (clients.size === 0) rooms.delete(room); }); return;
  }

  if (request.method === 'POST' && eventMatch) {
    const room = eventMatch[1].toLowerCase(); let rawBody = '';
    request.on('data', chunk => { rawBody += chunk; if (rawBody.length > 250_000) request.destroy(); });
    request.on('end', () => {
      try {
        const event = JSON.parse(rawBody || '{}');
        const custom = event.sound === 'custom' && validAsset(event.audioId) && assets.has(event.audioId);
        const privateRegister = event.type === 'private-register' && validAsset(event.privateId) && typeof event.name === 'string' && event.name.trim().length > 0 && event.name.length <= 80 && validIcon(event.icon);
        const privateTrigger = event.type === 'private-trigger' && validAsset(event.privateId);
        if (!validRoom(room) || (!custom && !privateRegister && !privateTrigger)) return sendJson(response, 400, { error: 'Invalid sound event.' });
        const payload = custom ? { sound: 'custom', audioId: event.audioId, name: assets.get(event.audioId).name, mimeType: assets.get(event.audioId).mimeType, sentAt: Date.now() } : privateRegister ? { type: 'private-register', privateId: event.privateId, name: event.name.trim(), icon: event.icon, sentAt: Date.now() } : { type: 'private-trigger', privateId: event.privateId, sentAt: Date.now() };
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
