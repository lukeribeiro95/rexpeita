const { Room, RoomEvent, Track } = LivekitClient;

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const sidebar = $('sidebar');
const audioSink = $('audio-sink');

const state = {
  room: null,
  tiles: new Map(),
  micEnabled: false,
  screenSharing: false,
  mutedParticipants: new Set(),
  joining: false,
  focusedSid: null,
  recordings: new Map(),
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
  if (state.joining || state.room) return;
  const name = $('name').value.trim();
  const roomName = $('room').value.trim().toUpperCase();
  const server = $('server').value.trim().replace(/\/$/, '');
  $('joinErr').textContent = '';

  if (!name || !roomName || !server) {
    $('joinErr').textContent = 'Preencha nome, sala e servidor.';
    return;
  }

  localStorage.setItem('tela:config', JSON.stringify({ name, room: roomName, server }));

  state.joining = true;
  const joinBtn = $('joinBtn');
  const originalLabel = joinBtn.textContent;
  joinBtn.disabled = true;
  joinBtn.textContent = 'Conectando...';

  try {
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
      adaptiveStream: false,
      dynacast: true,
      publishDefaults: {
        screenShareEncoding: {
          maxBitrate: 5_000_000,
          maxFramerate: 30,
        },
      },
    });
    state.room = room;

    room
      .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
      .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      .on(RoomEvent.LocalTrackPublished, onLocalTrackPublished)
      .on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished)
      .on(RoomEvent.ParticipantConnected, (p) => state.mutedParticipants.add(p.identity))
      .on(RoomEvent.Disconnected, onDisconnected);

    try {
      await room.connect(url, token);
    } catch (e) {
      $('joinErr').textContent = `Erro ao conectar: ${e.message}`;
      state.room = null;
      return;
    }

    room.remoteParticipants.forEach((p) => state.mutedParticipants.add(p.identity));

    $('roomLabel').textContent = `Sala ${roomName} — ${name}`;
    $('join').classList.add('hidden');
    $('room-view').classList.remove('hidden');
  } finally {
    state.joining = false;
    joinBtn.disabled = false;
    joinBtn.textContent = originalLabel;
  }
}

async function toggleShare() {
  const p = state.room?.localParticipant;
  if (!p) return;
  const btn = $('shareBtn');
  const errEl = $('roomErr');
  btn.disabled = true;
  errEl.textContent = '';
  try {
    state.screenSharing = !state.screenSharing;
    await p.setScreenShareEnabled(state.screenSharing, { audio: true });
    btn.textContent = state.screenSharing ? 'Parar compartilhamento' : 'Compartilhar tela';
  } catch (e) {
    state.screenSharing = !state.screenSharing;
    console.error('share error', e);
    const msg = e?.message || String(e);
    if (/audio source/i.test(msg)) {
      errEl.textContent = 'Essa janela nao tem audio pra capturar. Desmarque "Capturar audio so desta janela" e tente de novo.';
    } else if (!/permission|denied|cancel/i.test(msg)) {
      errEl.textContent = `Falha ao compartilhar: ${msg}`;
    }
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
  tile.dataset.sid = track.sid;

  const viewport = document.createElement('div');
  viewport.className = 'tile-viewport';

  const video = track.attach();
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;
  viewport.appendChild(video);

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `${participant.identity}${isLocal ? ' (voce)' : ''}`;

  const focusBtn = document.createElement('button');
  focusBtn.className = 'tile-focus';
  focusBtn.type = 'button';
  focusBtn.textContent = 'Foco';
  focusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFocus(track.sid);
  });

  const recBtn = document.createElement('button');
  recBtn.className = 'tile-rec';
  recBtn.type = 'button';
  recBtn.textContent = 'Gravar';
  recBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRecording(track, participant, recBtn);
  });

  tile.appendChild(viewport);
  tile.appendChild(label);
  tile.appendChild(focusBtn);
  tile.appendChild(recBtn);

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

  attachZoomHandlers(tile, viewport);

  grid.insertBefore(tile, sidebar);
  state.tiles.set(track.sid, tile);
  updateLayout();
}

function getVideoTiles() {
  return [
    ...Array.from(grid.children).filter((el) => el.classList.contains('tile')),
    ...Array.from(sidebar.children).filter((el) => el.classList.contains('tile')),
  ];
}

function attachZoomHandlers(tile, viewport) {
  const st = { zoom: 1, x: 0, y: 0, scale: 1 };
  tile._zoom = st;

  const apply = () => {
    viewport.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.zoom})`;
    tile.classList.toggle('zoomed', st.zoom > 1.001);
  };

  const applyScale = () => {
    tile.style.setProperty('--tile-scale', st.scale);
  };

  const clampPan = () => {
    const rect = tile.getBoundingClientRect();
    const minX = -(st.zoom - 1) * rect.width;
    const minY = -(st.zoom - 1) * rect.height;
    st.x = Math.min(0, Math.max(minX, st.x));
    st.y = Math.min(0, Math.max(minY, st.y));
  };

  tile.addEventListener('wheel', (e) => {
    e.preventDefault();
    const inFocusMode = grid.classList.contains('focus-mode');
    const resizeTile = !e.ctrlKey && !inFocusMode;

    if (resizeTile) {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      st.scale = Math.min(10, Math.max(0.1, st.scale * factor));
      applyScale();
      return;
    }

    const rect = tile.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const prev = st.zoom;
    const next = Math.min(50, Math.max(1, st.zoom * factor));
    if (next === prev) return;
    const ratio = next / prev;
    st.x = cx - (cx - st.x) * ratio;
    st.y = cy - (cy - st.y) * ratio;
    st.zoom = next;
    if (st.zoom <= 1.001) { st.zoom = 1; st.x = 0; st.y = 0; }
    else clampPan();
    apply();
  }, { passive: false });

  let dragging = null;
  tile.addEventListener('mousedown', (e) => {
    if (st.zoom <= 1) return;
    if (e.target.closest('.tile-mute') || e.target.closest('.tile-focus')) return;
    dragging = { sx: e.clientX, sy: e.clientY, ix: st.x, iy: st.y };
    tile.classList.add('dragging');
    e.preventDefault();
  });
  const onMove = (e) => {
    if (!dragging) return;
    st.x = dragging.ix + (e.clientX - dragging.sx);
    st.y = dragging.iy + (e.clientY - dragging.sy);
    clampPan();
    apply();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = null;
    tile.classList.remove('dragging');
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  tile.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tile-mute') || e.target.closest('.tile-focus')) return;
    st.zoom = 1;
    st.x = 0;
    st.y = 0;
    st.scale = 1;
    apply();
    applyScale();
  });
}

function toggleFocus(sid) {
  state.focusedSid = state.focusedSid === sid ? null : sid;
  updateLayout();
}

function updateLayout() {
  const videoTiles = getVideoTiles();
  const focused = state.focusedSid
    ? videoTiles.find((el) => el.dataset.sid === state.focusedSid)
    : null;

  if (focused && videoTiles.length > 1) {
    grid.classList.add('focus-mode');
    sidebar.classList.remove('hidden');
    videoTiles.forEach((el) => {
      el.classList.toggle('focused', el === focused);
      if (el === focused) {
        if (el.parentElement !== grid) grid.insertBefore(el, grid.firstChild);
        else if (grid.firstChild !== el) grid.insertBefore(el, grid.firstChild);
      } else {
        if (el.parentElement !== sidebar) sidebar.appendChild(el);
      }
    });
  } else {
    grid.classList.remove('focus-mode');
    sidebar.classList.add('hidden');
    videoTiles.forEach((el) => {
      el.classList.remove('focused');
      if (el.parentElement !== grid) grid.insertBefore(el, sidebar);
    });
    if (!focused) state.focusedSid = null;
  }

  videoTiles.forEach((el) => {
    const btn = el.querySelector('.tile-focus');
    if (!btn) return;
    btn.textContent = el === focused ? 'Grade' : 'Foco';
  });
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

function toggleRecording(track, participant, btn) {
  const sid = track.sid;
  const existing = state.recordings.get(sid);
  if (existing) {
    stopRecording(sid);
    return;
  }
  try {
    startRecording(track, participant, btn);
  } catch (e) {
    console.error('recording error', e);
    $('roomErr').textContent = `Falha ao gravar: ${e.message}`;
  }
}

function startRecording(track, participant, btn) {
  const sid = track.sid;
  const stream = new MediaStream();
  stream.addTrack(track.mediaStreamTrack);
  participant.audioTrackPublications.forEach((pub) => {
    if (pub.track?.mediaStreamTrack) stream.addTrack(pub.track.mediaStreamTrack);
  });

  const mimeType = MediaRecorder.isTypeSupported('video/webm; codecs=vp9,opus')
    ? 'video/webm; codecs=vp9,opus'
    : 'video/webm';
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const startTime = Date.now();
  const label = participant.identity;
  recorder.onstop = async () => {
    if (rec.timerId) clearInterval(rec.timerId);
    if (btn && document.body.contains(btn)) {
      btn.textContent = 'Gravar';
      btn.classList.remove('recording');
    }
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const buffer = await blob.arrayBuffer();
    const stamp = timestampForFilename();
    const safe = label.replace(/[^\w\-]+/g, '_');
    try {
      await window.telaAPI?.saveRecording(buffer, `Tela-${safe}-${stamp}.webm`);
    } catch (e) {
      console.error('save recording error', e);
      $('roomErr').textContent = `Falha ao salvar: ${e.message}`;
    }
  };

  recorder.start(1000);
  const rec = { recorder, chunks, startTime, timerId: null, btn };
  state.recordings.set(sid, rec);

  const updateTimer = () => {
    if (!btn || !document.body.contains(btn)) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    btn.textContent = `Parar ${mm}:${ss}`;
  };
  updateTimer();
  rec.timerId = setInterval(updateTimer, 1000);
  btn.classList.add('recording');
}

function stopRecording(sid) {
  const rec = state.recordings.get(sid);
  if (!rec) return;
  state.recordings.delete(sid);
  try {
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  } catch (e) {
    console.error('stop recording error', e);
  }
}

function stopAllRecordings() {
  Array.from(state.recordings.keys()).forEach(stopRecording);
}

function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function removeTile(sid) {
  const el = state.tiles.get(sid);
  if (el) el.remove();
  state.tiles.delete(sid);
  if (state.recordings.has(sid)) stopRecording(sid);
  if (state.focusedSid === sid) state.focusedSid = null;
  updateLayout();
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
  $('pickerAudioOpt').classList.toggle('hidden', tab !== 'window');
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
  const captureAudio = pickerTab === 'window' && $('pickerCaptureAudio').checked;
  $('picker').classList.add('hidden');
  window.telaAPI?.respondPickSource({ id, captureAudio });
}

function cancelPicker() {
  $('picker').classList.add('hidden');
  window.telaAPI?.respondPickSource(null);
}

function onDisconnected() {
  stopAllRecordings();
  getVideoTiles().forEach((el) => el.remove());
  sidebar.classList.add('hidden');
  audioSink.innerHTML = '';
  state.tiles.clear();
  state.mutedParticipants.clear();
  state.room = null;
  state.screenSharing = false;
  state.micEnabled = false;
  state.focusedSid = null;
  grid.classList.remove('focus-mode');
  $('shareBtn').textContent = 'Compartilhar tela';
  $('micBtn').textContent = 'Ligar microfone';
  $('room-view').classList.add('hidden');
  $('join').classList.remove('hidden');
}
