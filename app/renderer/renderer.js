const { Room, RoomEvent, Track } = LivekitClient;

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const audioSink = $('audio-sink');

const state = {
  room: null,
  tiles: new Map(),
  micEnabled: false,
  screenSharing: false,
  mutedParticipants: new Set(),
};

const saved = JSON.parse(localStorage.getItem('tela:config') || '{}');
$('name').value = saved.name || '';
$('room').value = saved.room || '';
$('server').value = saved.server || 'https://tela-token-server.onrender.com';

$('joinBtn').addEventListener('click', join);
$('leaveBtn').addEventListener('click', () => state.room?.disconnect());
$('shareBtn').addEventListener('click', toggleShare);
$('micBtn').addEventListener('click', toggleMic);

setupPicker();

async function join() {
  const name = $('name').value.trim();
  const roomName = $('room').value.trim().toUpperCase();
  const server = $('server').value.trim().replace(/\/$/, '');
  $('joinErr').textContent = '';

  if (!name || !roomName || !server) {
    $('joinErr').textContent = 'Preencha nome, sala e servidor.';
    return;
  }

  localStorage.setItem('tela:config', JSON.stringify({ name, room: roomName, server }));

  let token, url;
  try {
    const res = await fetch(`${server}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: roomName, name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ({ token, url } = await res.json());
  } catch (e) {
    $('joinErr').textContent = `Erro ao obter token: ${e.message}`;
    return;
  }

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: {
      resolution: { width: 1920, height: 1080, frameRate: 30 },
    },
  });
  state.room = room;

  room
    .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
    .on(RoomEvent.LocalTrackPublished, onLocalTrackPublished)
    .on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished)
    .on(RoomEvent.Disconnected, onDisconnected);

  try {
    await room.connect(url, token);
  } catch (e) {
    $('joinErr').textContent = `Erro ao conectar: ${e.message}`;
    state.room = null;
    return;
  }

  $('roomLabel').textContent = `Sala ${roomName} — ${name}`;
  $('join').classList.add('hidden');
  $('room-view').classList.remove('hidden');
}

async function toggleShare() {
  const p = state.room?.localParticipant;
  if (!p) return;
  const btn = $('shareBtn');
  btn.disabled = true;
  try {
    state.screenSharing = !state.screenSharing;
    await p.setScreenShareEnabled(state.screenSharing, { audio: true });
    btn.textContent = state.screenSharing ? 'Parar compartilhamento' : 'Compartilhar tela';
  } catch (e) {
    state.screenSharing = !state.screenSharing;
    console.error('share error', e);
  } finally {
    btn.disabled = false;
  }
}

async function toggleMic() {
  const p = state.room?.localParticipant;
  if (!p) return;
  state.micEnabled = !state.micEnabled;
  await p.setMicrophoneEnabled(state.micEnabled);
  $('micBtn').textContent = state.micEnabled ? 'Mutar microfone' : 'Ligar microfone';
}

function onTrackSubscribed(track, _pub, participant) {
  if (track.kind === Track.Kind.Video) {
    addVideoTile(track, participant, false);
  } else if (track.kind === Track.Kind.Audio) {
    const el = track.attach();
    el.dataset.participant = participant.identity;
    if (state.mutedParticipants.has(participant.identity)) el.muted = true;
    audioSink.appendChild(el);
    state.tiles.set(track.sid, el);
  }
}

function onTrackUnsubscribed(track) {
  removeTile(track.sid);
  track.detach().forEach((el) => el.remove());
}

function onLocalTrackPublished(pub, participant) {
  if (pub.source === Track.Source.ScreenShare && pub.track) {
    addVideoTile(pub.track, participant, true);
  }
}

function onLocalTrackUnpublished(pub) {
  if (pub.track) removeTile(pub.track.sid);
}

function addVideoTile(track, participant, isLocal) {
  const tile = document.createElement('div');
  tile.className = 'tile';

  const video = track.attach();
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `${participant.identity}${isLocal ? ' (voce)' : ''}`;

  tile.appendChild(video);
  tile.appendChild(label);

  if (!isLocal) {
    const muteBtn = document.createElement('button');
    muteBtn.className = 'tile-mute';
    muteBtn.type = 'button';
    updateMuteButton(muteBtn, participant.identity);
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleParticipantMute(participant.identity);
      updateMuteButton(muteBtn, participant.identity);
    });
    tile.appendChild(muteBtn);
  }

  grid.appendChild(tile);
  state.tiles.set(track.sid, tile);
}

function toggleParticipantMute(identity) {
  const shouldMute = !state.mutedParticipants.has(identity);
  if (shouldMute) state.mutedParticipants.add(identity);
  else state.mutedParticipants.delete(identity);
  audioSink
    .querySelectorAll(`audio[data-participant="${CSS.escape(identity)}"]`)
    .forEach((el) => { el.muted = shouldMute; });
}

function updateMuteButton(btn, identity) {
  const muted = state.mutedParticipants.has(identity);
  btn.textContent = muted ? 'Desmutar' : 'Mutar';
  btn.classList.toggle('active', muted);
}

function removeTile(sid) {
  const el = state.tiles.get(sid);
  if (el) el.remove();
  state.tiles.delete(sid);
}

let pickerSources = [];
let pickerTab = 'screen';

function setupPicker() {
  if (!window.telaAPI) return;

  window.telaAPI.onPickSource((sources) => {
    pickerSources = sources || [];
    const hasScreen = pickerSources.some((s) => s.type === 'screen');
    pickerTab = hasScreen ? 'screen' : 'window';
    setActiveTab(pickerTab);
    renderPickerList();
    $('picker').classList.remove('hidden');
  });

  $('pickerCancel').addEventListener('click', cancelPicker);

  document.querySelectorAll('.picker-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      pickerTab = btn.dataset.tab;
      setActiveTab(pickerTab);
      renderPickerList();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('picker').classList.contains('hidden')) {
      cancelPicker();
    }
  });
}

function setActiveTab(tab) {
  document.querySelectorAll('.picker-tabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
}

function renderPickerList() {
  const list = $('pickerList');
  list.innerHTML = '';
  const filtered = pickerSources.filter((s) => s.type === pickerTab);
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'picker-empty';
    empty.textContent = 'Nada disponivel.';
    list.appendChild(empty);
    return;
  }
  filtered.forEach((s) => {
    const item = document.createElement('button');
    item.className = 'picker-item';
    item.type = 'button';

    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail;
      img.alt = '';
      item.appendChild(img);
    }

    const nameRow = document.createElement('div');
    nameRow.className = 'picker-name';
    if (s.appIcon) {
      const icon = document.createElement('img');
      icon.className = 'picker-icon';
      icon.src = s.appIcon;
      icon.alt = '';
      nameRow.appendChild(icon);
    }
    const label = document.createElement('span');
    label.textContent = s.name;
    nameRow.appendChild(label);
    item.appendChild(nameRow);

    item.addEventListener('click', () => choosePicker(s.id));
    list.appendChild(item);
  });
}

function choosePicker(id) {
  $('picker').classList.add('hidden');
  window.telaAPI?.respondPickSource(id);
}

function cancelPicker() {
  $('picker').classList.add('hidden');
  window.telaAPI?.respondPickSource(null);
}

function onDisconnected() {
  grid.innerHTML = '';
  audioSink.innerHTML = '';
  state.tiles.clear();
  state.mutedParticipants.clear();
  state.room = null;
  state.screenSharing = false;
  state.micEnabled = false;
  $('shareBtn').textContent = 'Compartilhar tela';
  $('micBtn').textContent = 'Ligar microfone';
  $('room-view').classList.add('hidden');
  $('join').classList.remove('hidden');
}
