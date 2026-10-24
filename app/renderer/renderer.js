const { Room, RoomEvent, Track, AudioPresets } = LivekitClient;

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const sidebar = $('sidebar');
const audioSink = $('audio-sink');

const state = {
  room: null,
  tiles: new Map(),
  micEnabled: false,
  screenSharing: false,
  mutedMic: new Set(),
  mutedScreen: new Set(),
  joining: false,
  focusedSid: null,
  recordings: new Map(),
  systemAudio: null,
  noiseFilter: localStorage.getItem('tela:noiseFilter') !== 'off',
};

// Toca no AudioContext o PCM (16-bit, 48 kHz, estereo) que vem do tela-loopback.exe.
const SYSTEM_AUDIO_WORKLET = `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(48000 * 2);
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.port.onmessage = (e) => this.push(new Int16Array(e.data));
  }
  push(pcm) {
    const cap = this.buf.length;
    for (let i = 0; i < pcm.length; i++) {
      this.buf[this.write] = pcm[i] / 32768;
      this.write = (this.write + 1) % cap;
    }
    this.size += pcm.length;
    // segura a latencia: se acumular mais de 100ms, pula pra 40ms do fim
    if (this.size > 9600) {
      this.size = 3840;
      this.read = (this.write - this.size + cap) % cap;
    }
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    for (let i = 0; i < left.length; i++) {
      if (this.size >= 2) {
        left[i] = this.buf[this.read];
        right[i] = this.buf[this.read + 1];
        this.read = (this.read + 2) % this.buf.length;
        this.size -= 2;
      } else {
        left[i] = 0;
        right[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
`;

const saved = JSON.parse(localStorage.getItem('tela:config') || '{}');
$('name').value = saved.name || '';
$('room').value = saved.room || '';
$('server').value = saved.server || 'https://tela-token-server.onrender.com';

$('joinBtn').addEventListener('click', join);
$('leaveBtn').addEventListener('click', () => state.room?.disconnect());
$('shareBtn').addEventListener('click', toggleShare);
$('micBtn').addEventListener('click', toggleMic);
$('noiseBtn').addEventListener('click', toggleNoiseFilter);
updateNoiseButton();

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
      .on(RoomEvent.ParticipantConnected, renderParticipants)
      .on(RoomEvent.ParticipantDisconnected, renderParticipants)
      .on(RoomEvent.Disconnected, onDisconnected);

    try {
      await room.connect(url, token);
    } catch (e) {
      $('joinErr').textContent = `Erro ao conectar: ${e.message}`;
      state.room = null;
      return;
    }

    renderParticipants();

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
    if (!state.screenSharing) await stopSystemAudio();
    await p.setScreenShareEnabled(state.screenSharing, { audio: true });
    if (state.screenSharing) await startSystemAudio();
    btn.textContent = state.screenSharing ? 'Parar compartilhamento' : 'Compartilhar tela';
  } catch (e) {
    state.screenSharing = !state.screenSharing;
    stopSystemAudio();
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

// Publica o audio do sistema (sem o som do proprio Tela) quando o main
// conseguiu iniciar o tela-loopback.exe; senao o audio ja veio pelo getDisplayMedia.
async function startSystemAudio() {
  if (!(await window.telaAPI?.isLoopbackActive())) return;
  const ctx = new AudioContext({ sampleRate: 48000 });
  let off = null;
  try {
    const url = URL.createObjectURL(new Blob([SYSTEM_AUDIO_WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'pcm-player', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    await ctx.resume();
    off = window.telaAPI.onLoopbackData((bytes) => {
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      node.port.postMessage(copy, [copy]);
    });
    const track = dest.stream.getAudioTracks()[0];
    state.systemAudio = { ctx, off, track };
    await state.room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShareAudio,
      name: 'screen_audio',
      dtx: false,
      red: false,
      forceStereo: true,
      audioPreset: AudioPresets.musicHighQualityStereo,
    });
  } catch (e) {
    console.error('system audio error', e);
    $('roomErr').textContent = `Falha no audio da tela: ${e?.message || e}`;
    if (!state.systemAudio) {
      off?.();
      ctx.close();
    }
    await stopSystemAudio();
  }
}

async function stopSystemAudio() {
  window.telaAPI?.stopLoopback();
  const sa = state.systemAudio;
  if (!sa) return;
  state.systemAudio = null;
  sa.off();
  try {
    await state.room?.localParticipant.unpublishTrack(sa.track);
  } catch (e) {
    console.error('unpublish system audio error', e);
  }
  sa.track.stop();
  sa.ctx.close();
}

let rnnoiseWasm = null;

// Filtro de ruido com IA (RNNoise) aplicado no microfone, como processor do LiveKit.
function createNoiseFilter() {
  let ctx = null;
  let source = null;
  let node = null;
  return {
    name: 'tela-rnnoise',
    processedTrack: undefined,
    async init({ track }) {
      // RNNoise assume 48 kHz, entao usa um AudioContext proprio
      ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule('vendor/rnnoise/workletProcessor.js');
      if (!rnnoiseWasm) {
        rnnoiseWasm = await (await fetch('vendor/rnnoise/rnnoise_simd.wasm')).arrayBuffer();
      }
      source = ctx.createMediaStreamSource(new MediaStream([track]));
      node = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
        processorOptions: { maxChannels: 1, wasmBinary: rnnoiseWasm },
      });
      const dest = ctx.createMediaStreamDestination();
      source.connect(node).connect(dest);
      await ctx.resume();
      this.processedTrack = dest.stream.getAudioTracks()[0];
    },
    async restart(opts) {
      await this.destroy();
      await this.init(opts);
    },
    async destroy() {
      source?.disconnect();
      node?.port.postMessage('destroy');
      node?.disconnect();
      await ctx?.close();
      ctx = source = node = null;
      this.processedTrack = undefined;
    },
  };
}

async function applyNoiseFilter() {
  const track = state.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
  if (!track) return;
  const active = track.getProcessor()?.name === 'tela-rnnoise';
  try {
    if (state.noiseFilter && !active) await track.setProcessor(createNoiseFilter());
    else if (!state.noiseFilter && active) await track.stopProcessor();
  } catch (e) {
    console.error('noise filter error', e);
    $('roomErr').textContent = `Falha no filtro de ruido: ${e?.message || e}`;
  }
}

async function toggleNoiseFilter() {
  state.noiseFilter = !state.noiseFilter;
  localStorage.setItem('tela:noiseFilter', state.noiseFilter ? 'on' : 'off');
  updateNoiseButton();
  await applyNoiseFilter();
}

function updateNoiseButton() {
  const btn = $('noiseBtn');
  btn.textContent = `Filtro de ruido: ${state.noiseFilter ? 'ligado' : 'desligado'}`;
  btn.classList.toggle('active', state.noiseFilter);
}

async function toggleMic() {
  const p = state.room?.localParticipant;
  if (!p) return;
  try {
    await p.setMicrophoneEnabled(!state.micEnabled);
    state.micEnabled = !state.micEnabled;
    $('roomErr').textContent = '';
    if (state.micEnabled) await applyNoiseFilter();
  } catch (e) {
    console.error('mic error', e);
    $('roomErr').textContent = `Falha no microfone: ${e?.message || e}`;
  }
  $('micBtn').textContent = state.micEnabled ? 'Mutar microfone' : 'Ligar microfone';
}

function onTrackSubscribed(track, _pub, participant) {
  if (track.kind === Track.Kind.Video) {
    if (_pub.source === Track.Source.ScreenShare) {
      autoMuteScreen(participant.identity);
    }
    addVideoTile(track, participant, false);
  } else if (track.kind === Track.Kind.Audio) {
    const el = track.attach();
    const kind = _pub.source === Track.Source.ScreenShareAudio ? 'screen' : 'mic';
    el.dataset.participant = participant.identity;
    el.dataset.kind = kind;
    el.muted = muteSet(kind).has(participant.identity);
    audioSink.appendChild(el);
    state.tiles.set(track.sid, el);
  }
}

function autoMuteScreen(identity) {
  if (state.mutedScreen.has(identity)) return;
  setMuted('screen', identity, true);
}

function renderParticipants() {
  const bar = $('participants');
  bar.innerHTML = '';
  const peers = Array.from(state.room?.remoteParticipants.values() || []);
  bar.classList.toggle('hidden', peers.length === 0);
  peers.forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'peer';
    const name = document.createElement('span');
    name.textContent = p.identity;
    chip.appendChild(name);
    chip.appendChild(createMuteButton('mic', p.identity));
    chip.appendChild(createMuteButton('screen', p.identity));
    bar.appendChild(chip);
  });
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
  if (pub.source === Track.Source.ScreenShare) stopSystemAudio();
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

  const fsBtn = document.createElement('button');
  fsBtn.className = 'tile-fs';
  fsBtn.type = 'button';
  fsBtn.textContent = 'Tela cheia';
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen(tile);
  });

  tile.appendChild(viewport);
  tile.appendChild(label);
  tile.appendChild(focusBtn);
  tile.appendChild(recBtn);
  tile.appendChild(fsBtn);

  if (!isLocal) {
    const mutes = document.createElement('div');
    mutes.className = 'tile-mutes';
    mutes.appendChild(createMuteButton('mic', participant.identity));
    mutes.appendChild(createMuteButton('screen', participant.identity));
    tile.appendChild(mutes);
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
    const inFocusMode = grid.classList.contains('focus-mode') || document.fullscreenElement === tile;
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
    if (e.target.closest('button')) return;
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
    if (e.target.closest('button')) return;
    st.zoom = 1;
    st.x = 0;
    st.y = 0;
    st.scale = 1;
    apply();
    applyScale();
  });
}

function toggleFullscreen(tile) {
  if (document.fullscreenElement === tile) document.exitFullscreen();
  else tile.requestFullscreen().catch((e) => console.error('fullscreen error', e));
}

document.addEventListener('fullscreenchange', () => {
  document.querySelectorAll('.tile-fs').forEach((btn) => {
    btn.textContent = btn.parentElement === document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  });
});

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

function muteSet(kind) {
  return kind === 'screen' ? state.mutedScreen : state.mutedMic;
}

function setMuted(kind, identity, muted) {
  const set = muteSet(kind);
  if (muted) set.add(identity);
  else set.delete(identity);
  audioSink
    .querySelectorAll(`audio[data-participant="${CSS.escape(identity)}"][data-kind="${kind}"]`)
    .forEach((el) => { el.muted = muted; });
  document
    .querySelectorAll(`button[data-mute-kind="${kind}"][data-participant="${CSS.escape(identity)}"]`)
    .forEach(updateMuteButton);
}

function createMuteButton(kind, identity) {
  const btn = document.createElement('button');
  btn.className = 'tile-mute';
  btn.type = 'button';
  btn.dataset.muteKind = kind;
  btn.dataset.participant = identity;
  updateMuteButton(btn);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMuted(kind, identity, !muteSet(kind).has(identity));
  });
  return btn;
}

function updateMuteButton(btn) {
  const kind = btn.dataset.muteKind;
  const muted = muteSet(kind).has(btn.dataset.participant);
  const what = kind === 'screen' ? 'som da tela' : 'mic';
  btn.textContent = `${muted ? 'Desmutar' : 'Mutar'} ${what}`;
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
  stopSystemAudio();
  getVideoTiles().forEach((el) => el.remove());
  sidebar.classList.add('hidden');
  audioSink.innerHTML = '';
  state.tiles.clear();
  state.mutedMic.clear();
  state.mutedScreen.clear();
  $('participants').innerHTML = '';
  $('participants').classList.add('hidden');
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
