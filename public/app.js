const allowedExtensions = /\.(mp3|wav|ogg|m4a|aac|flac|webm|mp4)$/i;
const toggle = document.querySelector('#networkToggle'), panel = document.querySelector('#connectionPanel'), roleButtons = [...document.querySelectorAll('[data-role]')], roomForm = document.querySelector('#roomForm'), roomCode = document.querySelector('#roomCode'), statusCard = document.querySelector('#statusCard'), statusText = document.querySelector('#statusText'), board = document.querySelector('#board'), emptyBoard = document.querySelector('#emptyBoard');
const customPanel = document.querySelector('#customPanel'), customFile = document.querySelector('#customFile'), addCustom = document.querySelector('#addCustom'), recipientPanel = document.querySelector('#recipientPanel'), recipientName = document.querySelector('#recipientSoundName'), recipientAudio = document.querySelector('#recipientAudio'), recipientIcon = document.querySelector('#recipientIcon'), stockIcon = document.querySelector('#stockIcon'), addRecipientSound = document.querySelector('#addRecipientSound'), incomingPanel = document.querySelector('#incomingPanel'), incomingList = document.querySelector('#incomingList');
let role = null, connectedRoom = null, receiver = null;
const temporaryAudio = new Map();
const myPrivateIds = new Set(JSON.parse(localStorage.getItem('pulseboard:mine') || '[]'));
function rememberMine(id) { myPrivateIds.add(id); localStorage.setItem('pulseboard:mine', JSON.stringify([...myPrivateIds])); }

function newRoomCode() { return Math.random().toString(36).slice(2, 8); }
function setStatus(text, connected = false) { statusText.textContent = text; statusCard.classList.toggle('connected', connected); }
function validAudio(file) { return file && file.size <= 25 * 1024 * 1024 && (allowedExtensions.test(file.name) || file.type.startsWith('audio/')); }
function playAudio(blob) { const audio = new Audio(URL.createObjectURL(blob)); audio.play().catch(() => setStatus('Tap the sound button to allow playback.', true)); }
function openStore() { return new Promise((resolve, reject) => { const request = indexedDB.open('pulseboard-audio', 1); request.onupgradeneeded = () => request.result.createObjectStore('clips'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function cachedClip(id) { const db = await openStore(); return new Promise(resolve => { const request = db.transaction('clips').objectStore('clips').get(id); request.onsuccess = () => resolve(request.result || null); request.onerror = () => resolve(null); }); }
async function saveClip(id, clip) { const db = await openStore(); return new Promise((resolve, reject) => { const request = db.transaction('clips', 'readwrite').objectStore('clips').put(clip, id); request.onsuccess = resolve; request.onerror = () => reject(request.error); }); }
async function sendEvent(payload) { if (!connectedRoom) throw new Error('Connect to a room first.'); const response = await fetch(`/api/rooms/${encodeURIComponent(connectedRoom)}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Could not send to the room.'); } }
async function fetchRemote(url) { const response = await fetch(url); if (!response.ok) throw new Error('This audio is no longer available.'); return response.blob(); }

function iconNode(icon) {
  const slot = document.createElement('span'); slot.className = 'sound-emoji';
  if (icon && typeof icon === 'object' && icon.type === 'custom') { const image = document.createElement('img'); image.className = 'custom-icon'; image.src = icon.url; image.alt = ''; slot.append(image); }
  else { const value = (icon && typeof icon === 'object') ? icon.value : icon; slot.textContent = value || '🎵'; }
  return slot;
}
function addTile({ id, name, icon, kind }) { if (document.querySelector(`[data-tile-id="${id}"]`)) return; const button = document.createElement('button'); button.type = 'button'; button.className = 'sound-button custom'; button.dataset.tileId = id; button.dataset.kind = kind; const title = document.createElement('span'); title.textContent = name; const subtitle = document.createElement('small'); subtitle.textContent = kind === 'private' ? 'Recipient-owned audio' : 'Shared audio'; button.append(iconNode(icon), title, subtitle); board.append(button); emptyBoard.hidden = true; }

async function fetchShared(id) { return fetchRemote(`/api/audio/${id}`); }
async function playShared(id) { let clip = temporaryAudio.get(id) || await cachedClip(`shared:${id}`); if (!clip) { clip = await fetchShared(id); temporaryAudio.set(id, clip); } playAudio(clip); }
async function playPrivate(id) { let clip = await cachedClip(`private:${id}`); if (!clip) { clip = await fetchRemote(`/api/private-sounds/${id}/audio`); try { await saveClip(`private:${id}`, clip); } catch {} } playAudio(clip); }

function showIncoming(message) { if (document.querySelector(`[data-incoming-id="${message.audioId}"]`)) return; incomingPanel.hidden = false; const card = document.createElement('article'); card.className = 'incoming-card'; card.dataset.incomingId = message.audioId; card.innerHTML = `<div><strong></strong><small>Shared audio from this room</small></div><div class="incoming-actions"><button type="button" class="connect-button" data-choice="keep">Add sound</button></div>`; card.querySelector('strong').textContent = message.name; incomingList.prepend(card); card.addEventListener('click', async event => { const choice = event.target.dataset.choice; if (!choice) return; try { const clip = await fetchShared(message.audioId); await saveClip(`shared:${message.audioId}`, clip); addTile({ id: message.audioId, name: message.name, icon: '🎵', kind: 'shared' }); playAudio(clip); card.remove(); if (!incomingList.children.length) incomingPanel.hidden = true; setStatus(`${message.name} saved on this device.`, true); } catch (error) { setStatus(error.message, true); } }); }
async function handleRoomEvent(message) {
  if (message.sound === 'custom') { const clip = temporaryAudio.get(message.audioId) || await cachedClip(`shared:${message.audioId}`); if (clip) { addTile({ id: message.audioId, name: message.name, icon: '🎵', kind: 'shared' }); return playAudio(clip); } return showIncoming(message); }
  if (message.type === 'private-register') { if (role === 'sender' || myPrivateIds.has(message.privateId)) addTile({ id: message.privateId, name: message.name, icon: message.icon, kind: 'private' }); }
  if (message.type === 'private-trigger') { if (myPrivateIds.has(message.privateId)) { try { await playPrivate(message.privateId); } catch (error) { setStatus(error.message, true); } } }
}
function disconnect() { receiver?.close(); receiver = null; connectedRoom = null; customPanel.hidden = true; recipientPanel.hidden = true; incomingPanel.hidden = true; setStatus('Connect to a room to add sounds.'); }

toggle.addEventListener('click', () => { const enabled = toggle.getAttribute('aria-pressed') !== 'true'; toggle.setAttribute('aria-pressed', String(enabled)); toggle.querySelector('span:last-child').textContent = enabled ? 'Local sync on' : 'Local sync off'; panel.hidden = !enabled; if (!enabled) disconnect(); });
roleButtons.forEach(button => button.addEventListener('click', () => { role = button.dataset.role; roleButtons.forEach(item => { const selected = item === button; item.classList.toggle('selected', selected); item.setAttribute('aria-checked', String(selected)); }); roomForm.hidden = false; roomCode.value = role === 'sender' ? newRoomCode() : ''; roomCode.placeholder = role === 'sender' ? 'Share this code' : "Enter sender's code"; roomCode.focus(); }));
document.querySelector('#newRoom').addEventListener('click', () => { roomCode.value = newRoomCode(); });
roomForm.addEventListener('submit', event => { event.preventDefault(); const room = roomCode.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''); if (room.length < 3) return setStatus('Enter a room code with at least 3 characters.'); disconnect(); connectedRoom = room; receiver = new EventSource(`/api/rooms/${encodeURIComponent(room)}/events`); receiver.onopen = () => setStatus(`${role === 'sender' ? 'Sending' : 'Receiving'} room ${room}`, true); receiver.onmessage = eventMessage => handleRoomEvent(JSON.parse(eventMessage.data)); receiver.onerror = () => setStatus('Reconnecting to room…'); customPanel.hidden = role !== 'sender'; recipientPanel.hidden = role !== 'recipient'; });
customFile.addEventListener('change', () => { addCustom.disabled = !validAudio(customFile.files[0]); if (customFile.files[0] && addCustom.disabled) setStatus('Use an allowed audio format up to 25 MB.', true); });
addCustom.addEventListener('click', async () => { const file = customFile.files[0]; if (!validAudio(file)) return setStatus('Use an allowed audio format up to 25 MB.', true); addCustom.disabled = true; try { setStatus(`Uploading ${file.name}…`, true); const response = await fetch('/api/audio', { method: 'POST', headers: { 'Content-Type': file.type || 'audio/mpeg', 'X-Audio-Name': encodeURIComponent(file.name) }, body: file }); const asset = await response.json(); if (!response.ok) throw new Error(asset.error || 'Upload failed.'); temporaryAudio.set(asset.id, file); addTile({ id: asset.id, name: asset.name, icon: '🎵', kind: 'shared' }); customFile.value = ''; setStatus(`${asset.name} is ready to send.`, true); } catch (error) { setStatus(error.message, true); } finally { addCustom.disabled = !validAudio(customFile.files[0]); } });
recipientIcon.addEventListener('change', () => { const file = recipientIcon.files[0]; if (!file) return; if (!file.type.startsWith('image/') || file.size > 140_000) { setStatus('Use a PNG, JPG, WebP, or GIF icon up to 140 KB.', true); recipientIcon.value = ''; } });
addRecipientSound.addEventListener('click', async () => {
  const file = recipientAudio.files[0], name = recipientName.value.trim(), iconFile = recipientIcon.files[0];
  if (!connectedRoom) return setStatus('Connect to a room first.', true);
  if (!name) return setStatus('Give your sound a name.', true);
  if (!validAudio(file)) return setStatus('Use an allowed audio format up to 25 MB.', true);
  if (iconFile && (!iconFile.type.startsWith('image/') || iconFile.size > 140_000)) return setStatus('Use a PNG, JPG, WebP, or GIF icon up to 140 KB.', true);
  addRecipientSound.disabled = true;
  try {
    setStatus(`Uploading ${name}…`, true);
    const response = await fetch('/api/private-sounds', { method: 'POST', headers: { 'Content-Type': file.type || 'audio/mpeg', 'X-Room': encodeURIComponent(connectedRoom), 'X-Sound-Name': encodeURIComponent(name), 'X-Icon': encodeURIComponent(iconFile ? 'custom' : stockIcon.value) }, body: file });
    const asset = await response.json(); if (!response.ok) throw new Error(asset.error || 'Upload failed.');
    let icon = asset.icon;
    if (iconFile) { const iconResponse = await fetch(`/api/private-sounds/${asset.id}/icon`, { method: 'POST', headers: { 'Content-Type': iconFile.type }, body: iconFile }); const iconAsset = await iconResponse.json(); if (!iconResponse.ok) throw new Error(iconAsset.error || 'Icon upload failed.'); icon = { type: 'custom', url: iconAsset.iconUrl }; }
    rememberMine(asset.id);
    addTile({ id: asset.id, name, icon, kind: 'private' });
    try { const clip = await fetchRemote(asset.audioUrl); await saveClip(`private:${asset.id}`, clip); } catch {}
    await sendEvent({ type: 'private-register', privateId: asset.id });
    recipientName.value = ''; recipientAudio.value = ''; recipientIcon.value = '';
    setStatus(`${name} is saved permanently and ready for the Sender.`, true);
  } catch (error) { setStatus(error.message, true); }
  finally { addRecipientSound.disabled = false; }
});
board.addEventListener('click', async event => { const button = event.target.closest('[data-tile-id]'); if (!button) return; const { tileId, kind } = button.dataset; button.classList.add('active'); setTimeout(() => button.classList.remove('active'), 160); try { if (kind === 'private') { if (role === 'sender') await sendEvent({ type: 'private-trigger', privateId: tileId }); else await playPrivate(tileId); } else if (kind === 'shared') { if (role === 'sender') { await playShared(tileId); await sendEvent({ sound: 'custom', audioId: tileId }); } else await playShared(tileId); } } catch (error) { setStatus(error.message, true); } });