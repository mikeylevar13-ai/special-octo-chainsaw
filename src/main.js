import './style.css';

document.querySelector('#app').innerHTML = `
  <header class="topbar">
    <div class="brand">
      <div class="logo">FL</div>
      <div>
        <div class="title">Flow‑Lab DAW</div>
        <div class="subtitle" id="subtitle">Recording • Mixer • FX</div>
      </div>
    </div>
    <div class="actions">
      <button id="btnNewProject" class="btn ghost">New</button>
      <button id="btnSaveProject" class="btn">Save</button>
    </div>
  </header>

  <main class="wrap">
    <section class="card">
      <div class="row">
        <h2>Project</h2>
        <select id="projectSelect"></select>
      </div>
      <div class="hint">Tip: use wired headphones to avoid echo/feedback. Bluetooth adds latency.</div>
    </section>

    <section class="card">
      <div class="row">
        <h2>Transport</h2>
        <div class="row">
          <button id="btnRecord" class="btn">● Record</button>
          <button id="btnStop" class="btn ghost" disabled>Stop</button>
          <button id="btnPlay" class="btn ghost" disabled>Play</button>
        </div>
      </div>

      <div class="transportGrid">
        <div class="transportCell">
          <div class="label">BPM</div>
          <input id="bpm" type="number" min="40" max="240" value="120">
        </div>

        <div class="transportCell">
          <div class="label">Count‑in</div>
          <select id="countIn">
            <option value="0">Off</option>
            <option value="1" selected>1 bar</option>
            <option value="2">2 bars</option>
          </select>
        </div>

        <div class="transportCell">
          <div class="label">Metronome</div>
          <button id="btnMet" class="btn ghost">Off</button>
        </div>

        <div class="transportCell">
          <div class="label">Master meter</div>
          <div class="meter"><div id="masterMeter" class="meterFill"></div></div>
        </div>
      </div>

      <div class="meta">
        <span id="recStatus">Idle</span>
        <span id="timeStatus">00:00</span>
      </div>
    </section>

    <section class="card">
      <div class="row">
        <h2>Tracks</h2>
        <button id="btnAddTrack" class="btn ghost">Add empty track</button>
      </div>
      <ul id="trackList" class="list"></ul>
    </section>

    <section class="card">
      <div class="row">
        <h2>Export</h2>
        <button id="btnExport" class="btn ghost" disabled>Mixdown (later)</button>
      </div>
      <div class="hint">WAV export + timeline editing comes next (Phase 3).</div>
    </section>
  </main>
`;

/* ===== Helpers ===== */
const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
};

/* ===== Storage ===== */
const LS_KEY = 'flowlab_projects_v1';

function loadAllProjects() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
  catch { return []; }
}
function saveAllProjects(arr) {
  localStorage.setItem(LS_KEY, JSON.stringify(arr));
}

function defaultProject() {
  return {
    id: uid(),
    name: `Project ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    bpm: 120,
    countInBars: 1,
    metronomeOn: false,
    tracks: [{
      id: uid(),
      name: 'Vox 1',
      muted: false,
      solo: false,
      gain: 0.9,
      fx: { reverb: 0.15, delay: 0.12 },
      takes: []
    }]
  };
}

let projects = loadAllProjects();
if (!projects.length) {
  projects = [defaultProject()];
  saveAllProjects(projects);
}
let project = projects[0];
if (!project.tracks || !project.tracks.length) project.tracks = defaultProject().tracks;

/* ===== Audio ===== */
let audioCtx = null;
let master = null;
let masterAnalyser = null;
let meterRAF = 0;

function ensureAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();

  master = audioCtx.createGain();
  master.gain.value = 1;

  masterAnalyser = audioCtx.createAnalyser();
  masterAnalyser.fftSize = 2048;

  master.connect(masterAnalyser);
  masterAnalyser.connect(audioCtx.destination);

  startMeter();
}

async function resumeAudioIfNeeded() {
  ensureAudio();
  if (audioCtx.state !== 'running') await audioCtx.resume();
}

function startMeter() {
  const meterEl = $('#masterMeter');
  const buf = new Uint8Array(2048);

  const tick = () => {
    if (!masterAnalyser) return;
    masterAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const pct = Math.min(100, Math.max(0, rms * 160));
    meterEl.style.width = `${pct}%`;
    meterRAF = requestAnimationFrame(tick);
  };

  cancelAnimationFrame(meterRAF);
  meterRAF = requestAnimationFrame(tick);
}

/* ===== Metronome + count-in ===== */
let metInterval = null;
let metOn = false;

function stopMetronome() {
  if (metInterval) clearInterval(metInterval);
  metInterval = null;
}

function beep(freq = 1200, ms = 30, gain = 0.15) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = freq;
  g.gain.value = gain;
  o.connect(g);
  g.connect(master);
  const now = audioCtx.currentTime;
  o.start(now);
  o.stop(now + ms / 1000);
}

function startMetronome() {
  stopMetronome();
  if (!audioCtx) return;
  const bpm = Number($('#bpm').value || 120);
  const intervalMs = (60_000 / bpm) | 0;
  let beat = 0;
  metInterval = setInterval(() => {
    const isDownbeat = beat % 4 === 0;
    beep(isDownbeat ? 1600 : 1200, 28, isDownbeat ? 0.2 : 0.13);
    beat++;
  }, intervalMs);
}

function setMetronome(on) {
  metOn = on;
  $('#btnMet').textContent = on ? 'On' : 'Off';
  $('#btnMet').classList.toggle('active', on);
  if (on) startMetronome();
  else stopMetronome();
}

async function doCountIn() {
  const bars = Number($('#countIn').value || 0);
  if (!bars) return;
  await resumeAudioIfNeeded();

  const bpm = Number($('#bpm').value || 120);
  const beatMs = 60_000 / bpm;
  const beats = bars * 4;

  $('#recStatus').textContent = `Count‑in: ${bars} bar(s)`;
  for (let i = 0; i < beats; i++) {
    const isDownbeat = i % 4 === 0;
    beep(isDownbeat ? 1600 : 1200, 28, isDownbeat ? 0.2 : 0.13);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, beatMs));
  }
}

/* ===== Playback (simple) ===== */
let isPlaying = false;
let playStartAt = 0;
let playTimer = null;

const audioEls = new Map(); // takeId -> HTMLAudioElement

function getOrCreateAudioEl(take) {
  if (audioEls.has(take.id)) return audioEls.get(take.id);
  const a = new Audio();
  a.src = take.blobUrl;
  a.preload = 'auto';
  audioEls.set(take.id, a);
  return a;
}

function stopAllAudioEls() {
  for (const a of audioEls.values()) {
    try { a.pause(); a.currentTime = 0; } catch {}
  }
}

function updateTimeUI() {
  if (!isPlaying) return;
  $('#timeStatus').textContent = fmtTime(performance.now() - playStartAt);
}
function startPlayTimer() {
  clearInterval(playTimer);
  playTimer = setInterval(updateTimeUI, 200);
}
function stopPlayTimer() {
  clearInterval(playTimer);
  playTimer = null;
  $('#timeStatus').textContent = '00:00';
}

function computeSoloState() {
  return { anySolo: project.tracks.some((t) => t.solo) };
}

async function playProject() {
  await resumeAudioIfNeeded();
  if (isPlaying) return;

  const { anySolo } = computeSoloState();

  isPlaying = true;
  $('#recStatus').textContent = 'Playing';
  $('#btnPlay').disabled = true;
  $('#btnStop').disabled = false;
  $('#btnRecord').disabled = true;

  playStartAt = performance.now();
  startPlayTimer();
  if (metOn) startMetronome();

  // Basic: start all takes together, respect mute/solo via element volume
  for (const t of project.tracks) {
    const audible = anySolo ? t.solo : !t.muted;
    for (const take of t.takes) {
      const el = getOrCreateAudioEl(take);
      el.volume = audible ? Math.max(0, Math.min(1, (t.gain ?? 0.9))) : 0;
      try {
        el.currentTime = 0;
        await el.play();
      } catch {}
    }
  }
}

function stopProject() {
  stopAllAudioEls();
  isPlaying = false;

  $('#btnPlay').disabled = project.tracks.every((t) => t.takes.length === 0);
  $('#btnStop').disabled = true;
  $('#btnRecord').disabled = false;

  stopPlayTimer();
  if (metOn) startMetronome();
  else stopMetronome();
}

/* ===== Recording ===== */
let isRecording = false;
let mediaStream = null;
let mediaRecorder = null;
let recChunks = [];
let recStartAt = 0;
let recTick = null;

async function getMicStream() {
  if (mediaStream) return mediaStream;

  // This prevents the “nothing happens” crash when mic APIs aren’t available
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Microphone not available here. Open the project in Safari (not in-app browser) and allow mic.');
    throw new Error('getUserMedia not available');
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return mediaStream;
}

function pickMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/aac',
  ];
  for (const t of types) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

async function recordToTrack(trackId) {
  await resumeAudioIfNeeded();
  if (isRecording) return;
  if (isPlaying) stopProject();

  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return;

  const stream = await getMicStream();

  const mimeType = pickMimeType();
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recChunks = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const blobUrl = URL.createObjectURL(blob);

    track.takes.unshift({
      id: uid(),
      name: `Take ${track.takes.length + 1}`,
      blobUrl,
      mimeType: blob.type,
      createdAt: Date.now(),
      durationMs: Math.max(0, performance.now() - recStartAt),
    });

    isRecording = false;
    clearInterval(recTick);
    recTick = null;

    $('#recStatus').textContent = 'Saved take';
    $('#timeStatus').textContent = '00:00';
    $('#btnStop').disabled = true;
    $('#btnRecord').disabled = false;
    $('#btnPlay').disabled = project.tracks.every((t) => t.takes.length === 0);

    render();
  };

  isRecording = true;
  $('#recStatus').textContent = `Recording → ${track.name}`;
  $('#btnStop').disabled = false;
  $('#btnRecord').disabled = true;
  $('#btnPlay').disabled = true;

  await doCountIn();
  if (metOn) startMetronome();

  recStartAt = performance.now();
  clearInterval(recTick);
  recTick = setInterval(() => {
    $('#timeStatus').textContent = fmtTime(performance.now() - recStartAt);
  }, 200);

  mediaRecorder.start(200);
}

function stopRecording() {
  if (!isRecording) return;
  try { mediaRecorder?.stop(); } catch {}
  stopMetronome();
}

/* ===== Render ===== */
function renderProjectSelect() {
  const sel = $('#projectSelect');
  sel.innerHTML = '';
  projects = loadAllProjects();

  if (!projects.some((p) => p.id === project.id)) projects.unshift(project);

  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === project.id) opt.selected = true;
    sel.appendChild(opt);
  }

  sel.onchange = () => {
    const p = projects.find((x) => x.id === sel.value);
    if (!p) return;
    project = p;
    $('#bpm').value = project.bpm ?? 120;
    $('#countIn').value = String(project.countInBars ?? 1);
    setMetronome(!!project.metronomeOn);
    render();
  };
}

function renderTracks() {
  const ul = $('#trackList');
  ul.innerHTML = '';

  project.tracks.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'track';

    li.innerHTML = `
      <div class="trackTop">
        <div>
          <div class="trackName">${t.name}</div>
          <div class="hint">Takes: ${t.takes.length}</div>
        </div>

        <div class="trackControls">
          <button class="small ${t.muted ? 'active' : ''}" data-act="mute">Mute</button>
          <button class="small ${t.solo ? 'active' : ''}" data-act="solo">Solo</button>
          <button class="small" data-act="record">Record</button>
          <button class="small" data-act="rename">Rename</button>
          <button class="small" data-act="deleteTrack">Delete</button>
        </div>
      </div>

      <div class="transportCell">
        <div class="label">Volume</div>
        <div class="row">
          <input class="slider" data-act="gain" type="range" min="0" max="1.0" step="0.01" value="${t.gain ?? 0.9}">
          <span class="${t.muted ? 'bad' : 'good'}">${t.muted ? 'Muted' : 'On'}</span>
        </div>
      </div>

      <div>
        <div class="label">Takes</div>
        ${
          t.takes.length
            ? `<div class="hint">Tap Play to preview a take.</div>`
            : `<div class="hint">No takes yet. Tap Record to capture audio.</div>`
        }
        <ul class="list" style="margin-top:10px;">
          ${t.takes.map((take) => `
            <li class="transportCell" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
              <div style="min-width:0">
                <div style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${take.name}</div>
                <div class="hint">${new Date(take.createdAt).toLocaleString()} • ${fmtTime(take.durationMs)}</div>
              </div>
              <div class="row" style="justify-content:flex-end">
                <button class="small" data-act="playTake" data-take="${take.id}">Play</button>
                <button class="small" data-act="deleteTake" data-take="${take.id}">Delete</button>
              </div>
            </li>
          `).join('')}
        </ul>
      </div>
    `;

    li.querySelector('[data-act="mute"]').onclick = () => { t.muted = !t.muted; if (t.muted) t.solo = false; render(); };
    li.querySelector('[data-act="solo"]').onclick = () => { t.solo = !t.solo; if (t.solo) t.muted = false; render(); };
    li.querySelector('[data-act="record"]').onclick = async () => { await recordToTrack(t.id); };
    li.querySelector('[data-act="rename"]').onclick = () => {
      const name = prompt('Track name:', t.name);
      if (name && name.trim()) t.name = name.trim();
      render();
    };
    li.querySelector('[data-act="deleteTrack"]').onclick = () => {
      if (!confirm(`Delete track "${t.name}"?`)) return;
      for (const take of t.takes) { try { URL.revokeObjectURL(take.blobUrl); } catch {} }
      project.tracks = project.tracks.filter((x) => x.id !== t.id);
      if (!project.tracks.length) project.tracks = defaultProject().tracks;
      render();
    };

    li.querySelector('[data-act="gain"]').oninput = (e) => { t.gain = Number(e.target.value); };
    li.querySelector('[data-act="gain"]').onchange = () => render();

    li.querySelectorAll('[data-act="playTake"]').forEach((btn) => {
      btn.onclick = async () => {
        await resumeAudioIfNeeded();
        const takeId = btn.getAttribute('data-take');
        const take = t.takes.find((x) => x.id === takeId);
        if (!take) return;
        stopAllAudioEls();
        const el = getOrCreateAudioEl(take);
        el.volume = Math.max(0, Math.min(1, (t.gain ?? 0.9)));
        try { el.currentTime = 0; await el.play(); } catch {}
      };
    });

    li.querySelectorAll('[data-act="deleteTake"]').forEach((btn) => {
      btn.onclick = () => {
        const takeId = btn.getAttribute('data-take');
        const take = t.takes.find((x) => x.id === takeId);
        if (!take) return;
        if (!confirm(`Delete "${take.name}"?`)) return;
        try { URL.revokeObjectURL(take.blobUrl); } catch {}
        t.takes = t.takes.filter((x) => x.id !== takeId);
        render();
      };
    });

    ul.appendChild(li);
  });
}

function render() {
  project.bpm = Number($('#bpm').value || 120);
  project.countInBars = Number($('#countIn').value || 0);
  project.metronomeOn = !!metOn;

  renderProjectSelect();
  renderTracks();

  $('#btnPlay').disabled = project.tracks.every((t) => t.takes.length === 0) || isRecording || isPlaying;
  $('#btnStop').disabled = !isRecording && !isPlaying;
  $('#btnRecord').disabled = isRecording || isPlaying;

  $('#btnMet').classList.toggle('active', metOn);
}

/* ===== Top controls ===== */
$('#bpm').onchange = () => { project.bpm = Number($('#bpm').value || 120); if (metOn) startMetronome(); render(); };
$('#countIn').onchange = () => { project.countInBars = Number($('#countIn').value || 0); render(); };

$('#btnMet').onclick = async () => { await resumeAudioIfNeeded(); setMetronome(!metOn); project.metronomeOn = metOn; render(); };

$('#btnAddTrack').onclick = () => {
  project.tracks.push({
    id: uid(),
    name: `Track ${project.tracks.length + 1}`,
    muted: false,
    solo: false,
    gain: 0.9,
    fx: { reverb: 0.15, delay: 0.12 },
    takes: []
  });
  render();
};

$('#btnRecord').onclick = async () => {
  const t = project.tracks[0];
  await recordToTrack(t.id);
};

$('#btnPlay').onclick = async () => { await playProject(); };

$('#btnStop').onclick = () => {
  if (isRecording) stopRecording();
  stopProject();
  $('#recStatus').textContent = 'Idle';
};

$('#btnSaveProject').onclick = () => {
  const all = loadAllProjects();
  const idx = all.findIndex((p) => p.id === project.id);
  if (idx >= 0) all[idx] = project;
  else all.unshift(project);
  saveAllProjects(all);
  $('#recStatus').textContent = 'Saved project';
  renderProjectSelect();
};

$('#btnNewProject').onclick = () => {
  if (!confirm('Create a new project? (Press Save if you want to keep current changes.)')) return;
  project = defaultProject();
  $('#bpm').value = project.bpm;
  $('#countIn').value = String(project.countInBars);
  setMetronome(false);
  $('#recStatus').textContent = 'New project';
  render();
};

/* ===== Init ===== */
$('#bpm').value = project.bpm ?? 120;
$('#countIn').value = String(project.countInBars ?? 1);
setMetronome(!!project.metronomeOn);
render();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMetronome();
  else if (metOn) startMetronome();
});
