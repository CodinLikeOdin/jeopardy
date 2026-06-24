// ── Title Screen ─────────────────────────────────────────────
(function initTitleScreen() {
  const screen = document.getElementById('titleScreen');
  const canvas = document.getElementById('particleCanvas');
  const ctx = canvas.getContext('2d');
  const countdownEl = document.getElementById('titleCountdown');
  const DURATION = 10000;
  const start = Date.now();

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  // Particles
  const COLORS = ['#F5A623','#FFE066','#fff','#FFD700','#FFA500','#fffbe6'];
  const particles = Array.from({ length: 120 }, () => spawnParticle(true));

  function spawnParticle(initial) {
    return {
      x: Math.random() * window.innerWidth,
      y: initial ? Math.random() * window.innerHeight : window.innerHeight + 10,
      r: Math.random() * 3.5 + 1,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      vx: (Math.random() - 0.5) * 1.2,
      vy: -(Math.random() * 2.5 + 0.8),
      alpha: Math.random() * 0.6 + 0.4,
      spin: (Math.random() - 0.5) * 0.15,
      shape: Math.random() < 0.5 ? 'star' : 'circle',
      twinkle: Math.random() * Math.PI * 2,
    };
  }

  function drawStar(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const outer = (i * Math.PI * 4) / 5 - Math.PI / 2;
      const inner = outer + Math.PI / 5;
      if (i === 0) ctx.moveTo(x + r * Math.cos(outer), y + r * Math.sin(outer));
      else ctx.lineTo(x + r * Math.cos(outer), y + r * Math.sin(outer));
      ctx.lineTo(x + (r * 0.4) * Math.cos(inner), y + (r * 0.4) * Math.sin(inner));
    }
    ctx.closePath();
    ctx.fill();
  }

  let animId;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const elapsed = Date.now() - start;
    const remaining = Math.max(0, Math.ceil((DURATION - elapsed) / 1000));
    countdownEl.textContent = remaining > 0 ? `${remaining}s` : '';

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.twinkle += 0.06;
      const alpha = p.alpha * (0.7 + 0.3 * Math.sin(p.twinkle));

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      if (p.shape === 'star') {
        drawStar(ctx, p.x, p.y, p.r * 2);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      if (p.y < -20) Object.assign(p, spawnParticle(false));
    }

    if (elapsed < DURATION) {
      animId = requestAnimationFrame(animate);
    }
  }
  animate();

  // Dismiss after DURATION
  setTimeout(() => {
    cancelAnimationFrame(animId);
    screen.classList.add('fade-out');
    setTimeout(() => screen.remove(), 1200);
  }, DURATION);
})();

// ── Game ──────────────────────────────────────────────────────
const socket = io();
let myId = null;
let isHost = false;
let state = null;
let buzzPending = false;      // optimistic: emitted a buzz, awaiting next state
let activeAudioKey = null;    // which question's audio we've already scheduled
let shownQuestionKey = null;  // detects when a new question modal appears

// ── Clock synchronization (NTP-style) ────────────────────────
// Each contestant estimates its offset from the server clock so that a single
// server-chosen moment (buzzArmTime / audioStartTime) maps to the same real
// instant on every device. This is what makes the buzz race fair.
let clockOffset = 0;
function serverNow() { return Date.now() + clockOffset; }

(function runClockSync() {
  const samples = [];
  function ping() { socket.emit('syncPing', Date.now()); }
  socket.on('syncPong', ({ t0, serverTime }) => {
    const t1 = Date.now();
    const rtt = t1 - t0;
    // serverTime was taken ~midway through the round trip
    samples.push({ rtt, offset: serverTime - (t0 + t1) / 2 });
    if (samples.length < 8) {
      setTimeout(ping, 120);
    } else {
      samples.sort((a, b) => a.rtt - b.rtt);           // trust the lowest-latency samples
      const best = samples.slice(0, 3);
      clockOffset = best.reduce((s, x) => s + x.offset, 0) / best.length;
    }
  });
  socket.on('connect', () => { samples.length = 0; ping(); });
  // Re-sync periodically to correct drift
  setInterval(() => { samples.length = 0; ping(); }, 25000);
})();

// ── Synced clue audio (plays on EVERY device at ~the same instant) ──
// Mobile browsers (iOS Safari especially) only allow audio.play() on an
// element that was first played inside a user gesture. We keep ONE persistent
// <audio> element, "unlock" it on the Join tap, then just swap its src per
// clue — so scheduled playback from a timer is permitted. The buzz race stays
// fair via the server's buzzArmTime, independent of audio.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
let clueAudioEl = null;
let clueAudioUrl = null;
function getClueAudioEl() {
  if (!clueAudioEl) clueAudioEl = new Audio();
  return clueAudioEl;
}

// Small on-screen diagnostic so we can see which half (fetch vs playback) fails.
function setAudioStatus(text, tappable) {
  const el = document.getElementById('audioStatus');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = text;
  el.classList.toggle('tappable', !!tappable);
}

// Tap-to-play fallback if the browser blocked autoplay.
function retryClueAudio() {
  const el = getClueAudioEl();
  el.muted = false;
  el.play().then(() => setAudioStatus('🔊 audio playing')).catch(() => {});
}

async function scheduleClueAudio() {
  if (!state || !state.currentQuestion || state.audioStartTime == null) return;
  const q = state.currentQuestion;
  const key = `${q.round}|${q.category}|${q.valueIndex}`;
  if (key === activeAudioKey) return;   // already scheduled for this question
  activeAudioKey = key;
  setAudioStatus('♪ loading clue audio…');
  try {
    const res = await fetch('/api/tts/current');
    if (!res.ok) {                      // no audio (e.g. no API key on server)
      setAudioStatus(`🔇 no audio from server (${res.status})`);
      return;
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) { setAudioStatus('🔇 empty audio from server'); return; }
    if (clueAudioUrl) { URL.revokeObjectURL(clueAudioUrl); }
    clueAudioUrl = URL.createObjectURL(blob);
    const el = getClueAudioEl();
    el.muted = false;
    el.src = clueAudioUrl;
    el.load();
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      el.play()
        .then(() => setAudioStatus(''))                       // playing — hide indicator
        .catch(() => setAudioStatus('🔊 Tap here to hear the clue', true));
    };
    const delayMs = state.audioStartTime - serverNow();
    if (delayMs > 30) setTimeout(go, delayMs); else go();
  } catch (e) {
    setAudioStatus('🔇 audio error: ' + (e && e.message ? e.message : 'unknown'));
  }
}

// ── Sound effects (WebAudio, no assets needed) ───────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playBuzz(startTime, duration = 0.18, freq = 160) {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(0.3, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}
function playWrongSound() {
  // Three short, quick buzzes at the same tone — "nobody got it"
  const ctx = getAudioCtx();
  const t = ctx.currentTime;
  const FREQ = 200;
  playBuzz(t,        0.12, FREQ);
  playBuzz(t + 0.18, 0.12, FREQ);
  playBuzz(t + 0.36, 0.12, FREQ);
}

// ── Connection ──────────────────────────────────────────────
function unlockAudio() {
  // Unlock Web Audio (used for the buzzer)
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { /* ignore */ }
  // Unlock the persistent HTML <audio> element (used for clue playback) by
  // playing a silent clip within this user gesture. After this, scheduled
  // play() calls are allowed even on iOS.
  try {
    const el = getClueAudioEl();
    el.muted = true;
    el.src = SILENT_WAV;
    const p = el.play();
    if (p && p.then) {
      p.then(() => { el.pause(); el.currentTime = 0; el.muted = false; })
       .catch(() => { el.muted = false; });
    } else {
      el.pause(); el.muted = false;
    }
  } catch (e) { /* ignore */ }
}

function joinAsPlayer() {
  const name = document.getElementById('playerName').value.trim();
  if (!name) return alert('Enter your name first');
  unlockAudio();
  isHost = false;
  socket.emit('join', { name, isHost: false });
}

function joinAsHost() {
  const name = document.getElementById('playerName').value.trim() || 'Host';
  unlockAudio();
  isHost = true;
  socket.emit('join', { name, isHost: true });
}

let pendingPhoto = null;

// Capture & downscale a selfie to a small center-cropped JPEG before sending.
function onPhotoSelected(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Keep the photo's natural (rectangular) shape, capped at 480px on the
      // long edge — big enough to fill the full-screen judging grid.
      const maxDim = 480;
      const s = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * s));
      const h = Math.max(1, Math.round(img.height * s));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      pendingPhoto = canvas.toDataURL('image/jpeg', 0.7);
      const prev = document.getElementById('photoPreview');
      prev.src = pendingPhoto; prev.classList.remove('hidden');
      // If we've already joined, send it now
      if (myId) socket.emit('setPhoto', { dataUrl: pendingPhoto });
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Render a player's avatar — their photo if uploaded, else a colored initial.
function avatar(id, p, size) {
  if (p.hasPhoto) {
    return `<img class="avatar" src="/api/photo/${id}?v=${p.photoVersion || 0}" style="width:${size}px;height:${size}px">`;
  }
  const initial = escHtml((p.name && p.name[0] ? p.name[0] : '?').toUpperCase());
  return `<div class="avatar avatar-initial" style="width:${size}px;height:${size}px;background:${p.color}">${initial}</div>`;
}

socket.on('joined', ({ id }) => {
  myId = id;
  if (pendingPhoto) socket.emit('setPhoto', { dataUrl: pendingPhoto });
});

socket.on('state', (s) => {
  state = s;
  if (myId) render();
});

// Nobody buzzed within the time limit — play the "nobody got it" buzzers
socket.on('questionTimeout', () => {
  playWrongSound();
});

socket.on('error', ({ message }) => {
  alert('Error: ' + message);
});

// A lightweight ticker re-evaluates time-sensitive modal bits as the synced
// clock crosses the audio-start moment and the buzz arm time (no server message
// fires at those instants).
let modalTicker = null;
function ensureModalTicker(active) {
  if (active && !modalTicker) modalTicker = setInterval(tickModal, 80);
  else if (!active && modalTicker) { clearInterval(modalTicker); modalTicker = null; }
}

// Reveal the clue text only once the spoken audio has started, and show the
// "BUZZ NOW!" cue once buzzers arm. Driven by the synced clock.
function tickModal() {
  if (!state || !state.currentQuestion) { ensureModalTicker(false); return; }
  const q = state.currentQuestion;
  const now = serverNow();
  const audioStarted = state.audioStartTime != null && now >= state.audioStartTime;
  const armed = state.buzzArmTime != null && now >= state.buzzArmTime;
  const hasTopBuzzer = state.buzzers && state.buzzers.length > 0;
  // Judging: someone buzzed and the host hasn't ruled yet → show photos + scores
  const judging = hasTopBuzzer && !q.revealed && !q.isDailyDouble;

  // Clue text appears when the speech begins (or once revealed), but is hidden
  // during the judging screen (and reappears on a wrong answer when buzzers reopen)
  const clueEl = document.getElementById('modalClue');
  if ((audioStarted || q.revealed) && !judging) clueEl.classList.remove('hidden');
  else clueEl.classList.add('hidden');

  // Only a "BUZZ NOW!" cue (the old "Reading…" message is gone)
  const rs = document.getElementById('readingStatus');
  if (armed && !hasTopBuzzer && !q.revealed && !q.isDailyDouble) {
    rs.classList.remove('hidden');
    rs.textContent = '🔔 BUZZ NOW!';
  } else {
    rs.classList.add('hidden');
  }

  updateBuzzButton();
}

// The judging screen: full-screen grid of contestant photos with each score
// overlaid (white) on the bottom third. Buzzed-in player highlighted. Shown
// from buzz-in until the host rules. The host also gets answer + judge buttons.
function renderJudgingPanel() {
  const panel = document.getElementById('judgingPanel');
  const q = state.currentQuestion;
  const buzzerId = state.buzzers[0] && state.buzzers[0].id;
  const players = Object.entries(state.players);
  const n = players.length || 1;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  const cells = players.map(([id, p]) => {
    const img = p.hasPhoto
      ? `<img class="jp-img" src="/api/photo/${id}?v=${p.photoVersion || 0}">`
      : `<div class="jp-img jp-noimg" style="background:${p.color}">${escHtml((p.name && p.name[0] ? p.name[0] : '?').toUpperCase())}</div>`;
    return `<div class="jp-cell${id === buzzerId ? ' buzzed' : ''}">
      <div class="jp-top">
        <div class="jp-score">$${p.score.toLocaleString()}</div>
        <div class="jp-name">${escHtml(p.name)}${id === buzzerId ? ' 🔔' : ''}</div>
      </div>
      ${img}
    </div>`;
  }).join('');

  let hostBar = '';
  if (isHost && buzzerId) {
    const player = state.players[buzzerId];
    const value = q.dollarValue;
    hostBar = `<div class="jp-hostbar">
      <div class="jp-answer">${escHtml(q.answer)}</div>
      <div class="jp-buttons">
        <button class="award-btn award-correct" onclick="awardPoints('${buzzerId}', true)">✓ Correct (+$${value})</button>
        <button class="award-btn award-wrong" onclick="awardPoints('${buzzerId}', false)">✗ Wrong (-$${value})</button>
      </div>
    </div>`;
  }

  panel.innerHTML =
    `<div class="jp-grid" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">${cells}</div>${hostBar}`;
}

// The buzz button is rendered from authoritative server state plus the synced
// clock. Pressing before buzzArmTime (or during a lockout) is allowed but
// penalized server-side — that's the anti-mash mechanic.
function updateBuzzButton() {
  const btn = document.getElementById('buzzBtn');
  if (!btn) return;

  const q = state && state.currentQuestion;
  if (!q || !state.buzzOpen || q.isDailyDouble || q.revealed) {
    btn.classList.add('hidden');
    return;
  }
  // A player who already answered wrong is out for this question
  if ((q.bannedPlayers || []).includes(myId)) {
    btn.classList.add('hidden');
    return;
  }

  const buzzers = state.buzzers || [];
  const iAmBuzzer = buzzers.some(b => b.id === myId);
  if (buzzers.length > 0) {
    // Someone won the buzz
    if (iAmBuzzer) { btn.classList.remove('hidden'); btn.disabled = true; btn.textContent = 'BUZZED!'; }
    else btn.classList.add('hidden');
    return;
  }

  btn.classList.remove('hidden');

  const now = serverNow();
  const arm = state.buzzArmTime;
  const myLock = (state.lockUntil && state.lockUntil[myId]) || 0;

  if (myLock && now < myLock) {
    btn.disabled = true; btn.textContent = 'TOO EARLY!';
  } else if (buzzPending) {
    btn.disabled = true; btn.textContent = 'BUZZING…';
  } else if (arm != null && now < arm) {
    // Pre-arm: pressable, but pressing now penalizes you (anti-mash)
    btn.disabled = false; btn.textContent = 'WAIT…';
  } else {
    btn.disabled = false; btn.textContent = 'BUZZ IN';
  }
}

// ── Render ───────────────────────────────────────────────────
let categoriesPreloaded = false;
let categoryPool = [];

function getUsedCategories() {
  return Array.from(document.querySelectorAll('.cat-input'))
    .map(i => i.value.trim().toLowerCase())
    .filter(Boolean);
}

function pickRandom(exclude = []) {
  const excluded = exclude.map(s => s.toLowerCase());
  const available = categoryPool.filter(c => !excluded.includes(c.toLowerCase()));
  if (!available.length) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function rerollOne(btn) {
  const input = btn.closest('.cat-row').querySelector('.cat-input');
  const used = getUsedCategories().filter(c => c !== input.value.trim().toLowerCase());
  const pick = pickRandom(used);
  if (pick) input.value = pick;
}

function rerollAll() {
  const singleInputs = Array.from(document.querySelectorAll('.single-cat'));
  const doubleInputs = Array.from(document.querySelectorAll('.double-cat'));
  const used = [];
  [...singleInputs, ...doubleInputs].forEach(input => {
    const pick = pickRandom(used);
    if (pick) { input.value = pick; used.push(pick.toLowerCase()); }
  });
}

function rowInput(btn) {
  return btn.closest('.cat-row').querySelector('.cat-input');
}

async function poolAction(action, topic) {
  const res = await fetch('/api/categories/pool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, topic }),
  });
  if (!res.ok) throw new Error();
  categoryPool = (await res.json()).pool;
}

// Save the topic typed in THIS row to the persistent random-selection pool.
async function addTopicFromRow(btn) {
  const t = (rowInput(btn).value || '').trim();
  if (!t) return alert('Type a topic in this field first.');
  try {
    await poolAction('add', t);
    alert(`Saved "${t}" to the pool (${categoryPool.length} topics).`);
  } catch (e) {
    alert('Could not save the topic.');
  }
}

// Remove the topic in THIS row from the persistent random-selection pool.
async function deleteTopicFromRow(btn) {
  const t = (rowInput(btn).value || '').trim();
  if (!t) return alert('This field is empty — nothing to remove.');
  if (!confirm(`Remove "${t}" from the saved pool?`)) return;
  try {
    await poolAction('remove', t);
    alert(`Removed "${t}" from the pool (${categoryPool.length} topics).`);
  } catch (e) {
    alert('Could not remove the topic.');
  }
}

function render() {
  if (!state) return;

  showScreen(state.phase);

  if (state.phase === 'setup' && isHost && !categoriesPreloaded) {
    categoriesPreloaded = true;
    fetch('/api/categories')
      .then(r => r.json())
      .then(data => {
        categoryPool = data.pool || [];
        const singleInputs = document.querySelectorAll('.single-cat');
        const doubleInputs = document.querySelectorAll('.double-cat');
        data.single.forEach((cat, i) => { if (singleInputs[i]) singleInputs[i].value = cat; });
        data.double.forEach((cat, i) => { if (doubleInputs[i]) doubleInputs[i].value = cat; });
      });
  }

  if (state.phase === 'lobby' || state.phase === 'setup' || state.phase === 'generating') {
    renderLobby();
  }
  if (state.phase === 'setup' && isHost) {
    showScreen('setup');
  }
  if (state.phase === 'generating') {
    showScreen('generating');
    const gs = document.getElementById('genStatus');
    if (gs && state.genProgress) {
      const { done, total } = state.genProgress;
      gs.textContent = `Writing clues… ${done} of ${total} categories ready`;
    }
  }
  if (state.phase === 'single' || state.phase === 'double') {
    renderGame();
  }
  if (state.phase === 'gameover') {
    renderGameOver();
  }
}

function showScreen(phase) {
  const map = {
    lobby: 'lobby',
    setup: isHost ? 'setup' : 'lobby',
    generating: 'generating',
    single: 'game',
    double: 'game',
    gameover: 'gameover',
  };
  const screens = ['landing', 'lobby', 'setup', 'generating', 'game', 'gameover'];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const target = map[phase] || 'lobby';
  const el = document.getElementById(target);
  if (el) el.classList.remove('hidden');
}

function renderLobby() {
  const players = Object.entries(state.players || {});
  document.getElementById('lobbyContent').innerHTML = `
    <h2>Waiting for Host to Start</h2>
    <p style="color:#aaa;margin-bottom:8px">Players joined:</p>
    <div class="player-list">
      ${players.map(([id, p]) => `<div class="player-chip" style="background:${p.color}">${avatar(id, p, 28)}${escHtml(p.name)}</div>`).join('')}
    </div>
  `;
}

function renderGame() {
  const round = state.phase;
  const board = round === 'single' ? state.board.single : state.board.double;
  const values = round === 'single' ? [100,200,300,400,500] : [200,400,600,800,1000];
  const label = round === 'single' ? 'SINGLE JEOPARDY' : 'DOUBLE JEOPARDY';

  document.getElementById('roundLabel').textContent = label;

  // Scoreboard
  const players = Object.entries(state.players || {});
  const controlPlayer = state.boardControl ? state.players[state.boardControl] : null;
  document.getElementById('scoreboard').innerHTML =
    (controlPlayer ? `<div class="control-chip" style="border-color:${controlPlayer.color}">🎯 ${escHtml(controlPlayer.name)}</div>` : '') +
    players
      .sort((a, b) => b[1].score - a[1].score)
      .map(([id, p]) => `<div class="score-chip${p.disconnected ? ' dim' : ''}" style="background:${p.color}">${avatar(id, p, 22)}${escHtml(p.name)}: $${p.score.toLocaleString()}</div>`)
      .join('');

  // Host controls
  const hc = document.getElementById('hostControls');
  if (isHost) hc.classList.remove('hidden'); else hc.classList.add('hidden');

  // Board grid — use the category keys from the current round's board
  const boardData = round === 'single' ? state.board.single : state.board.double;
  const cats = boardData ? Object.keys(boardData) : (state.categories || []);
  const numCols = cats.length;
  const boardEl = document.getElementById('board');
  boardEl.style.gridTemplateColumns = `repeat(${numCols}, 1fr)`;
  boardEl.style.gridTemplateRows = `auto repeat(5, 1fr)`;

  let html = '';
  // Category headers
  cats.forEach(cat => {
    html += `<div class="board-cat">${escHtml(cat)}</div>`;
  });

  // Value rows
  for (let row = 0; row < 5; row++) {
    cats.forEach(cat => {
      const key = `${cat}|${row}`;
      const used = state.usedSquares && state.usedSquares[round] && state.usedSquares[round][key];
      const val = values[row];
      if (used) {
        html += `<div class="board-cell used"></div>`;
      } else {
        const clickHandler = isHost
          ? `onclick="selectSquare('${round}','${escAttr(cat)}',${row})"`
          : '';
        html += `<div class="board-cell" ${clickHandler}>$${val}</div>`;
      }
    });
  }

  boardEl.innerHTML = html;

  // Question modal
  renderQuestionModal();
}

function renderQuestionModal() {
  const modal = document.getElementById('questionModal');
  if (!state.currentQuestion) {
    modal.classList.add('hidden');
    ensureModalTicker(false);
    return;
  }
  modal.classList.remove('hidden');

  const q = state.currentQuestion;
  document.getElementById('modalCategory').textContent = q.category;
  document.getElementById('modalValue').textContent = q.isDailyDouble ? 'DAILY DOUBLE' : `$${q.dollarValue}`;
  document.getElementById('modalClue').textContent = q.clue;

  // New question? reset the optimistic buzz flag.
  const questionKey = `${q.round}|${q.category}|${q.valueIndex}`;
  if (questionKey !== shownQuestionKey) {
    shownQuestionKey = questionKey;
    buzzPending = false;
  }
  // Schedule synced audio on EVERY device (deduped internally per question)
  scheduleClueAudio();
  // Drive clue-text reveal, BUZZ-NOW cue, and buzz button off the synced clock
  ensureModalTicker(true);
  tickModal();

  const hasTopBuzzer = state.buzzers && state.buzzers.length > 0;
  const revealed = !!q.revealed;
  const ddReadyToJudge = q.isDailyDouble && state.dailyDoubleWager !== null;

  // Judging screen (photos + scores) — shown from buzz-in until the host rules
  const judging = hasTopBuzzer && !revealed && !q.isDailyDouble;
  const judgingPanel = document.getElementById('judgingPanel');
  if (judging) { renderJudgingPanel(); judgingPanel.classList.remove('hidden'); }
  else judgingPanel.classList.add('hidden');

  // Answer visibility:
  //  • revealed on timeout → shown to EVERYONE for 5s
  //  • otherwise the host sees it only when it's time to judge (a buzzer is
  //    locked in, or a daily double whose wager is set and reading is done)
  const answerEl = document.getElementById('modalAnswer');
  const hostJudging = isHost && (hasTopBuzzer || ddReadyToJudge);
  if (revealed) {
    answerEl.textContent = 'Answer: ' + q.answer;
    answerEl.classList.remove('hidden');
  } else if (hostJudging) {
    answerEl.textContent = q.answer;
    answerEl.classList.remove('hidden');
  } else {
    answerEl.classList.add('hidden');
  }

  // Daily double section
  const ddSection = document.getElementById('dailyDoubleSection');
  const wagerSection = document.getElementById('wagerSection');
  if (q.isDailyDouble) {
    ddSection.classList.remove('hidden');
    if (isHost && state.dailyDoubleWager === null) {
      const ctrl = state.boardControl ? state.players[state.boardControl] : null;
      const ctrlName = ctrl ? escHtml(ctrl.name) : 'the controlling player';
      const maxWager = ctrl ? Math.max(ctrl.score, q.dollarValue) : q.dollarValue;
      wagerSection.innerHTML = `
        <span>${ctrlName}'s wager (max $${maxWager}):</span>
        <input type="number" id="wagerInput" min="5" max="${maxWager}" value="${q.dollarValue}" style="padding:8px;border-radius:6px;border:none">
        <button class="btn btn-primary btn-sm" onclick="submitWager(${maxWager})">Set Wager</button>
      `;
    } else if (state.dailyDoubleWager !== null) {
      wagerSection.innerHTML = `<strong>Wager: $${state.dailyDoubleWager}</strong>`;
    } else {
      wagerSection.innerHTML = '<em>Waiting for wager...</em>';
    }
  } else {
    ddSection.classList.add('hidden');
  }

  // Buzzers display — show only the first (winning) buzzer
  const buzzersEl = document.getElementById('buzzers');
  if (state.buzzers && state.buzzers.length > 0) {
    const b = state.buzzers[0];
    const player = state.players[b.id];
    const color = player ? player.color : '#888';
    buzzersEl.innerHTML = `
      <div class="buzzer-entry" style="background:${color}">
        <span><span class="place">🥇</span>${escHtml(b.name)}</span>
        <span class="buzz-time">buzzed in</span>
      </div>
    `;
  } else {
    buzzersEl.innerHTML = '';
  }

  // Judging controls (host only). Normal questions judge the top buzzer;
  // daily doubles judge the controlling player once the wager is set.
  const hqc = document.getElementById('hostQuestionControls');
  const awardContainer = document.getElementById('playerAwardButtons');
  const buzzBtn = document.getElementById('buzzBtn');
  const topBuzzer = state.buzzers && state.buzzers[0];

  let judgeId = null, judgeValue = q.dollarValue;
  if (topBuzzer) {
    judgeId = topBuzzer.id;
    judgeValue = (q.isDailyDouble && state.dailyDoubleWager !== null) ? state.dailyDoubleWager : q.dollarValue;
  } else if (ddReadyToJudge) {
    judgeId = state.boardControl;
    judgeValue = state.dailyDoubleWager;
  }

  if (isHost && judgeId && !revealed) {
    hqc.classList.remove('hidden');
    const player = state.players[judgeId];
    awardContainer.innerHTML = `
      <strong style="width:100%;text-align:center">Judging: ${escHtml(player ? player.name : '?')}</strong>
      <button class="award-btn award-correct" onclick="awardPoints('${judgeId}', true)">✓ Correct (+$${judgeValue})</button>
      <button class="award-btn award-wrong" onclick="awardPoints('${judgeId}', false)">✗ Wrong (-$${judgeValue})</button>
    `;
  } else {
    hqc.classList.add('hidden');
    awardContainer.innerHTML = '';
  }

  // Buzz button: only for normal questions, until someone is locked in
  if (q.isDailyDouble || topBuzzer || revealed) {
    buzzBtn.classList.add('hidden');
  } else {
    updateBuzzButton();
  }
}

function renderGameOver() {
  const players = Object.entries(state.players || {}).sort((a, b) => b[1].score - a[1].score);
  const maxScore = players[0] && players[0][1].score;
  document.getElementById('finalScores').innerHTML = players.map(([id, p], i) => `
    <div class="final-score-row" style="background:${p.color}">
      <span class="fs-name">${avatar(id, p, 36)} ${i+1}. ${escHtml(p.name)}</span>
      <span>$${p.score.toLocaleString()}${p.score === maxScore && i === 0 ? '<span class="winner-crown">👑</span>' : ''}</span>
    </div>
  `).join('');
}

// ── Host Actions ──────────────────────────────────────────────
function submitCategories() {
  const single = Array.from(document.querySelectorAll('.single-cat')).map(i => i.value.trim()).filter(Boolean);
  const double = Array.from(document.querySelectorAll('.double-cat')).map(i => i.value.trim()).filter(Boolean);
  if (single.length < 1) return alert('Enter at least 1 Single Jeopardy category');
  if (double.length < 1) return alert('Enter at least 1 Double Jeopardy category');
  const enforceEarlyPenalty = document.getElementById('enforcePenalty').checked;
  const buzzTimeoutMs = (parseInt(document.getElementById('buzzSeconds').value, 10) || 8) * 1000;
  socket.emit('setCategories', {
    singleCategories: single,
    doubleCategories: double,
    settings: { enforceEarlyPenalty, buzzTimeoutMs },
  });
}

function selectSquare(round, category, valueIndex) {
  socket.emit('selectSquare', { round, category, valueIndex });
}

function awardPoints(playerId, correct) {
  socket.emit('awardPoints', { playerId, correct });
}

function advanceRound() {
  if (!confirm('Advance to the next round?')) return;
  socket.emit('advanceRound');
}

function resetGame() {
  if (!confirm('Reset the game?')) return;
  socket.emit('resetGame');
}

function submitWager(max) {
  const input = document.getElementById('wagerInput');
  let wager = parseInt(input.value, 10);
  if (isNaN(wager) || wager < 5) wager = 5;
  if (wager > max) wager = max;
  socket.emit('dailyDoubleWager', { wager });
}

// ── Player Actions ────────────────────────────────────────────
function buzz() {
  if (!state || !state.currentQuestion || !state.buzzOpen) return;
  const armed = state.buzzArmTime != null && serverNow() >= state.buzzArmTime;
  // Send my best estimate of the current SERVER time so buzzes are compared on
  // a common clock. Pressing early is allowed but the server will penalize it.
  socket.emit('buzz', { ts: serverNow() });
  if (armed) {
    buzzPending = true;            // optimistic only for real (armed) buzzes
    updateBuzzButton();
    setTimeout(() => { buzzPending = false; updateBuzzButton(); }, 600);
  } else {
    updateBuzzButton();           // pre-arm press → will show TOO EARLY from state
  }
}

// ── Utils ─────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return String(str).replace(/'/g,"\\'");
}
