// ── Title Screen ─────────────────────────────────────────────
let titleScreenDone = false;
function dismissTitleScreen() {
  if (titleScreenDone) return;
  titleScreenDone = true;
  const screen = document.getElementById('titleScreen');
  if (!screen) return;
  screen.classList.add('fade-out');
  setTimeout(() => screen.remove(), 1200);
}

(function initTitleScreen() {
  const screen = document.getElementById('titleScreen');
  if (!screen) { titleScreenDone = true; return; }
  const isHostUrl = /\/host\/?$/i.test(window.location.pathname);
  if (isHostUrl) { screen.remove(); titleScreenDone = true; return; }   // host: straight to setup, no splash
  const canvas = document.getElementById('particleCanvas');
  const ctx = canvas.getContext('2d');

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

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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

    if (!titleScreenDone) requestAnimationFrame(animate);
  }
  animate();

  // Guests: the gate (updateTitleGate, driven by game state) controls dismissal;
  // this is just a safety fallback so a guest is never stuck if no state arrives.
  setTimeout(dismissTitleScreen, 30000);
})();

// Guest title gate: keep the splash up (with a status message) until the host
// has finished generating questions; if the guest arrives after they're already
// generated, just show the splash briefly.
let titleFirstStateDone = null;
let titleDismissScheduled = false;
function generationDone() {
  return !!(state && ['review', 'single', 'double', 'final', 'gameover'].includes(state.phase));
}
function updateTitleGate() {
  if (titleScreenDone || IS_HOST_URL) return;
  const msg = document.getElementById('titleMessage');
  if (titleFirstStateDone === null && state) titleFirstStateDone = generationDone();
  if (!generationDone()) {
    if (msg) msg.textContent = 'Host is generating questions…';
    return;
  }
  if (msg) msg.textContent = '';
  if (!titleDismissScheduled) {
    titleDismissScheduled = true;
    setTimeout(dismissTitleScreen, titleFirstStateDone ? 5000 : 700);
  }
}

// ── Game ──────────────────────────────────────────────────────
const socket = io();
let myId = null;
let isHost = false;
let myName = null;            // remembered so we can re-join after a reconnect
let lastHostClaim = 0;        // throttles the host self-heal re-claim
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

// Voice mode chosen by the host at setup: 'elevenlabs' | 'browser' | 'off'.
function voiceMode() { return (state && state.settings && state.settings.voiceMode) || 'elevenlabs'; }

// Free browser TTS fallback. Only the HOST device speaks (it's the announcer),
// so phones in the room don't talk over each other. Scheduled to the synced
// clue-start moment.
function speakClue(text, atServerTime) {
  if (!isHost) return;
  if (!('speechSynthesis' in window) || !text) return;
  const go = () => {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.98; u.pitch = 0.9;
      const v = pickAnnouncerVoice();
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  };
  const delay = (atServerTime != null) ? atServerTime - serverNow() : 0;
  if (delay > 30) setTimeout(go, delay); else go();
}
function pickAnnouncerVoice() {
  try {
    const vs = window.speechSynthesis.getVoices() || [];
    return vs.find(v => /en[-_]US/i.test(v.lang) && /(male|daniel|fred|alex|aaron|arthur)/i.test(v.name))
        || vs.find(v => /^en/i.test(v.lang)) || null;
  } catch (e) { return null; }
}
function cancelSpeech() { try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) {} }

async function scheduleClueAudio() {
  if (!state || !state.currentQuestion || state.audioStartTime == null) return;
  const q = state.currentQuestion;
  const key = `${q.round}|${q.category}|${q.valueIndex}`;
  if (key === activeAudioKey) return;   // already scheduled for this question
  activeAudioKey = key;

  const mode = voiceMode();
  if (mode === 'off') { setAudioStatus(''); return; }            // silent (testing — no credits)
  if (mode === 'browser') {                                      // free browser voice (host speaks)
    setAudioStatus(isHost ? '🔊 Browser voice' : '');
    speakClue(q.clue, state.audioStartTime);
    return;
  }

  // Premium ElevenLabs; fall back to the browser voice if it's unavailable.
  const fallback = () => {
    setAudioStatus(isHost ? '🔊 Browser voice (ElevenLabs out)' : '🔇 Listen to the host');
    speakClue(q.clue, state.audioStartTime);
  };
  setAudioStatus('♪ loading clue audio…');
  try {
    const res = await fetch('/api/tts/current');
    if (!res.ok) { fallback(); return; }      // no audio (quota / cold start) → browser voice
    const blob = await res.blob();
    if (!blob || blob.size === 0) { fallback(); return; }
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
    fallback();
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

// ── Synthesized music (think-music + game-over theme, copyright-free) ─────
// Layered WebAudio voices scheduled against the synced clock so every device
// plays together. Reuses the same AudioContext as the buzzer.
const NOTE = { G4:392.0, A4:440.0, B4:493.88, C5:523.25, D5:587.33, E5:659.25,
  F5:698.46, G5:783.99, A5:880.0, B5:987.77, C6:1046.5 };

let masterGain = null;
function getMaster() {
  const ctx = getAudioCtx();
  if (!masterGain) { masterGain = ctx.createGain(); masterGain.gain.value = 0.9; masterGain.connect(ctx.destination); }
  return masterGain;
}

// One tonal voice with a short attack/decay envelope.
function mkVoice(ctx, freq, t, dur, type, vol) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(getMaster());
  o.start(t); o.stop(t + dur + 0.03);
  return o;
}

// A short percussive "tick" (hi-hat / clave feel).
function mkTick(ctx, t, freq, vol) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  o.connect(g); g.connect(getMaster());
  o.start(t); o.stop(t + 0.05);
  return o;
}

// Schedule one pass of `melody` from ctx-time `start`, layering ~5 instruments:
// melody, an octave-down doubling for warmth, an offbeat fifth, a percussive
// tick, and a sustained bass/pad on the downbeats. Pushes the oscillators into
// `bank` so they can be stopped; returns the phrase length (seconds).
function schedulePhrase(ctx, start, beat, melody, bank, end) {
  for (let i = 0; i < melody.length; i++) {
    const t = start + i * beat;
    if (end != null && t >= end - 0.001) break;
    const F = NOTE[melody[i]];
    bank.push(mkVoice(ctx, F, t, beat * 0.92, 'triangle', 0.13));         // melody
    bank.push(mkVoice(ctx, F / 2, t, beat * 0.92, 'sine', 0.10));         // octave-down warmth
    if (i % 2 === 1) bank.push(mkVoice(ctx, F * 1.5, t, beat * 0.5, 'square', 0.045));  // offbeat fifth
    bank.push(mkTick(ctx, t, i % melody.length === 0 ? 1400 : 2600, i % melody.length === 0 ? 0.09 : 0.05));
    if (i % 4 === 0) bank.push(mkVoice(ctx, F / 2, t, beat * 4 * 0.95, 'sawtooth', 0.05));  // bass/pad
  }
  return melody.length * beat;
}

// ── Final Jeopardy think-music ───────────────────────────────────────────
let jingleOscs = [];
let jingleStopTimer = null;
const JINGLE_MOTIF = ['G4','C5','E5','G5','E5','C5','D5','B4'];
const JINGLE_BEAT = 0.34;

function stopJingle() {
  jingleOscs.forEach(o => { try { o.stop(); } catch (e) {} });
  jingleOscs = [];
  if (jingleStopTimer) { clearTimeout(jingleStopTimer); jingleStopTimer = null; }
}

// Loop the motif to fill the WHOLE answer window, starting at the synced time.
function playJingle(serverStartTime, durationMs) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  stopJingle();
  const lead = (serverStartTime - serverNow()) / 1000;
  const start = ctx.currentTime + Math.max(0.03, lead);
  const end = start + durationMs / 1000;
  const phraseSec = JINGLE_MOTIF.length * JINGLE_BEAT;
  for (let t = start; t < end - 0.001; t += phraseSec) {
    schedulePhrase(ctx, t, JINGLE_BEAT, JINGLE_MOTIF, jingleOscs, end);
  }
  jingleStopTimer = setTimeout(stopJingle, durationMs + 300);
}

// Short triumphant flourish for the winner reveal.
function playFanfare() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + 0.02;
  [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((fq, i) =>
    mkVoice(ctx, fq, t + i * 0.12, 0.34, 'square', 0.18));
}

// ~1-second celebratory stinger when a Daily Double is revealed.
function playDailyDoubleStinger() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + 0.02;
  // Quick rising run...
  [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((fq, i) =>
    mkVoice(ctx, fq, t + i * 0.075, 0.16, 'square', 0.17));
  // ...into a bright held chord with a sparkle on top.
  const c = t + 0.30;
  mkVoice(ctx, NOTE.C6, c, 0.62, 'triangle', 0.14);
  mkVoice(ctx, NOTE.E5, c, 0.62, 'sawtooth', 0.10);
  mkVoice(ctx, NOTE.G5, c, 0.62, 'sine', 0.10);
  mkVoice(ctx, NOTE.C6 * 2, c + 0.04, 0.5, 'triangle', 0.08); // sparkle (C7)
}

// ── Game-over theme (elaborate; loops until you leave the screen) ─────────
let gameOverActive = false;
let gameOverTimer = null;
let gameOverOscs = [];
const GO_MELODY = ['C5','E5','G5','C6','B5','G5','E5','C5','A4','C5','F5','A5','G5','E5','D5','C5'];
const GO_BEAT = 0.40;

function stopGameOverTheme() {
  gameOverActive = false;
  if (gameOverTimer) { clearTimeout(gameOverTimer); gameOverTimer = null; }
  gameOverOscs.forEach(o => { try { o.stop(); } catch (e) {} });
  gameOverOscs = [];
}

// Loop the theme indefinitely, aligned to synced server-time phrase boundaries
// so devices stay roughly in phase. Keeps ~4s scheduled ahead, topped up each
// second, until stopGameOverTheme() (Play Again / leaving the screen).
function startGameOverTheme() {
  if (gameOverActive) return;
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  gameOverActive = true;
  const phraseMs = GO_MELODY.length * GO_BEAT * 1000;
  let nextServer = Math.ceil(serverNow() / phraseMs) * phraseMs;
  const pump = () => {
    if (!gameOverActive) return;
    while (nextServer < serverNow() + 4000) {
      const ctxAt = ctx.currentTime + (nextServer - serverNow()) / 1000;
      schedulePhrase(ctx, Math.max(ctx.currentTime + 0.02, ctxAt), GO_BEAT, GO_MELODY, gameOverOscs);
      nextServer += phraseMs;
    }
    if (gameOverOscs.length > 400) gameOverOscs = gameOverOscs.slice(-200); // keep recent/future for stop()
    gameOverTimer = setTimeout(pump, 1000);
  };
  pump();
}

// Fetch the current clue audio (Final Jeopardy) and play it at a synced time;
// if ElevenLabs has no audio, fall back to the browser voice (host).
let finalAudioKey = null;
async function playClueAudioAt(startTime, fallbackText) {
  try {
    const res = await fetch('/api/tts/current');
    if (!res.ok) { speakClue(fallbackText, startTime); return; }
    const blob = await res.blob();
    if (!blob || blob.size === 0) { speakClue(fallbackText, startTime); return; }
    if (clueAudioUrl) URL.revokeObjectURL(clueAudioUrl);
    clueAudioUrl = URL.createObjectURL(blob);
    const el = getClueAudioEl();
    el.muted = false;
    el.src = clueAudioUrl; el.load();
    let started = false;
    const go = () => { if (started) return; started = true; el.play().catch(() => {}); };
    const delay = startTime - serverNow();
    if (delay > 30) setTimeout(go, delay); else go();
  } catch (e) { speakClue(fallbackText, startTime); }
}

// Schedule clue speech + think-music once for the Final Jeopardy answer stage.
function scheduleFinalAudio() {
  const f = state && state.final;
  if (!f || f.stage !== 'answer' || f.audioStartTime == null) return;
  const key = 'final|' + f.audioStartTime;
  if (key === finalAudioKey) return;
  finalAudioKey = key;
  const mode = voiceMode();
  if (mode === 'browser') speakClue(f.clue, f.audioStartTime);
  else if (mode !== 'off') playClueAudioAt(f.audioStartTime, f.clue);   // elevenlabs (+ browser fallback)
  // (jingle always plays — it's music, not voice)
  if (f.jingleStart != null && f.jingleDurationMs) playJingle(f.jingleStart, f.jingleDurationMs);
}

// ── Winner celebration overlay ──────────────────────────────────────────
let winnerTimer = null;
function showWinnerOverlay(id, name) {
  const ov = document.getElementById('winnerOverlay');
  if (!ov) return;
  const p = state && state.players && state.players[id];
  const av = p ? avatar(id, p, 200) : '';
  ov.innerHTML = `
    <div class="winner-inner">
      <div class="winner-word">WINNER</div>
      <div class="winner-avatar">${av}</div>
      <div class="winner-name">${escHtml(name || (p && p.name) || '')}</div>
    </div>`;
  ov.classList.remove('hidden');
  playFanfare();
  if (winnerTimer) clearTimeout(winnerTimer);
  winnerTimer = setTimeout(() => ov.classList.add('hidden'), 7000);
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
  myName = name;
  socket.emit('join', { name, isHost: false });
}

function joinAsHost() {
  const name = document.getElementById('playerName').value.trim() || 'Host';
  unlockAudio();
  isHost = true;
  myName = name;
  socket.emit('join', { name, isHost: true });
}

// iOS Safari drops the WebSocket on background/lock/network blips; socket.io
// reconnects with a NEW socket id. Re-announce ourselves so the server re-binds
// our player entry (it reclaims by name, preserving score) — otherwise buzzes
// from the new socket are silently dropped (no player for that id).
socket.on('connect', () => {
  if (myName) socket.emit('join', { name: myName, isHost });
});
// Server asks us to re-join (e.g. it received an action from an unknown socket).
socket.on('rejoin', () => {
  if (myName) socket.emit('join', { name: myName, isHost });
});

// Role is decided by the URL: /host → host console; anything else → player.
const IS_HOST_URL = /\/host\/?$/i.test(window.location.pathname);
isHost = IS_HOST_URL;
(function initRole() {
  if (IS_HOST_URL) {
    // Host: skip the title + join button entirely — go straight to setup.
    const landing = document.getElementById('landing');
    if (landing) landing.classList.add('hidden');
    myName = 'Host';
    socket.emit('join', { name: 'Host', isHost: true });   // (re)emitted on connect too
    // No "Enter" button to unlock audio, so unlock on the host's first gesture.
    const unlockOnce = () => {
      unlockAudio();
      document.removeEventListener('pointerdown', unlockOnce);
      document.removeEventListener('keydown', unlockOnce);
    };
    document.addEventListener('pointerdown', unlockOnce);
    document.addEventListener('keydown', unlockOnce);
  } else {
    const ph = document.getElementById('landingPlayer');
    const ho = document.getElementById('landingHost');
    if (ph) ph.classList.remove('hidden');
    if (ho) ho.classList.add('hidden');
  }
})();

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
  // Host self-heal: if the server's host binding has drifted from our CURRENT
  // socket id (e.g. Safari/Render dropped the socket and reconnected with a new
  // id, or the server cold-started and lost hostId), re-claim host so host-only
  // actions (Start Over, regenerate, Start Game…) don't silently do nothing.
  // Throttled so two accidental host tabs can't ping-pong host ownership.
  if (isHost && s.hostId && socket.id && s.hostId !== socket.id && Date.now() - lastHostClaim > 3000) {
    lastHostClaim = Date.now();
    socket.emit('join', { name: 'Host', isHost: true });
  }
  updateTitleGate();     // guests wait on the title screen until questions are generated
  if (myId) render();
});

// Nobody buzzed within the time limit — play the "nobody got it" buzzers
socket.on('questionTimeout', () => {
  playWrongSound();
});

// Full-screen result flash (green CORRECT / red INCORRECT) shown for 2 seconds.
let resultTimer = null;
function showResultOverlay(big, sub, correct) {
  const ov = document.getElementById('incorrectOverlay');
  ov.classList.toggle('correct', !!correct);
  ov.innerHTML = `<div class="io-big">${big}</div><div class="io-sub">${sub}</div>`;
  ov.classList.remove('hidden');
  if (resultTimer) clearTimeout(resultTimer);
  resultTimer = setTimeout(() => ov.classList.add('hidden'), 2000);
}

socket.on('wrongAnswer', ({ name, lost }) => {
  playWrongSound();
  showResultOverlay('INCORRECT', `${escHtml(name || '')} &minus;$${Number(lost || 0).toLocaleString()}`, false);
});

socket.on('correctAnswer', ({ name, earned }) => {
  showResultOverlay('CORRECT', `${escHtml(name || '')} +$${Number(earned || 0).toLocaleString()}`, true);
});

socket.on('error', ({ message }) => {
  alert('Error: ' + message);
});

socket.on('boardSaved', ({ name }) => alert(`✅ Saved board "${name}". Load it later from the setup screen.`));
socket.on('boardLoaded', ({ name }) => { closeBoardPicker(); });
socket.on('boardsChanged', () => renderBoardPicker());

// Final Jeopardy answer window closed — stop the think-music everywhere.
socket.on('finalTimeUp', () => {
  stopJingle();
  // The accompanying state broadcast re-renders with the input disabled.
});

// Final Jeopardy winner — full-screen celebration on every device.
socket.on('finalWinner', ({ id, name }) => {
  showWinnerOverlay(id, name);
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
  const showClue = (audioStarted || q.revealed) && !judging;
  if (showClue) clueEl.classList.remove('hidden');
  else clueEl.classList.add('hidden');

  // Custom-category media reveals alongside the clue (image shows / audio plays).
  const mediaEl = document.getElementById('modalMedia');
  if (mediaEl) {
    const showMedia = q.media && showClue;
    mediaEl.classList.toggle('hidden', !showMedia);
    if (showMedia && q.media.type === 'audio') {
      const a = mediaEl.querySelector('audio');
      if (a && !a.dataset.tried) { a.dataset.tried = '1'; a.play().catch(() => {}); }
    }
  }

  // "BUZZ NOW!" cue — hidden for a player who already answered wrong (they only
  // see the clue while the others get their chance)
  const banned = (q.bannedPlayers || []).includes(myId);
  const rs = document.getElementById('readingStatus');
  if (armed && !hasTopBuzzer && !q.revealed && !q.isDailyDouble && !banned) {
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
  return Array.from(document.querySelectorAll('.cat-name'))
    .map(i => i.value.trim().toLowerCase())
    .filter(Boolean);
}

function pickRandom(exclude = []) {
  const excluded = exclude.map(s => s.toLowerCase());
  const available = categoryPool.filter(c => !excluded.includes(c.toLowerCase()));
  if (!available.length) return null;
  return available[Math.floor(Math.random() * available.length)];
}

// The name input for a row's buttons — board blocks use .cat-name; the Final
// Jeopardy row (single input) falls back to .cat-input.
function rowInput(btn) {
  const blk = btn.closest('.cat-block') || btn.closest('.cat-row');
  return blk.querySelector('.cat-name') || blk.querySelector('.cat-input');
}
// Keep the criteria field in step with the name on reroll. If criteria was
// empty or just auto-mirrored the PREVIOUS name (not custom-typed), follow the
// new name. If the host typed their own criteria, leave it alone.
function syncCriteria(blk, oldName, newName) {
  if (!blk) return;
  const crit = blk.querySelector('.cat-criteria');
  if (!crit) return;
  const cur = crit.value.trim();
  if (!cur || cur === (oldName || '').trim()) crit.value = newName;
}

function rerollOne(btn) {
  const input = rowInput(btn);
  const oldName = input.value;
  const used = getUsedCategories().filter(c => c !== input.value.trim().toLowerCase());
  const pick = pickRandom(used);
  if (pick) { input.value = pick; syncCriteria(btn.closest('.cat-block'), oldName, pick); }
  refreshCriteriaIndicators();
}

function rerollAll() {
  const used = [];
  Array.from(document.querySelectorAll('.cat-block')).forEach(blk => {
    const name = blk.querySelector('.cat-name');
    if (!name) return;
    const oldName = name.value;
    const pick = pickRandom(used);
    if (pick) {
      name.value = pick; used.push(pick.toLowerCase());
      syncCriteria(blk, oldName, pick);
    }
  });
  refreshCriteriaIndicators();
}

// Flag any category whose Question criteria differs from its displayed name, so
// the host can see at a glance that it'll generate from the criteria, not the name.
let setupIndicatorsWired = false;
function ensureSetupIndicators() {
  document.querySelectorAll('.cat-block').forEach(blk => {
    if (!blk.querySelector('.cat-crit-note')) {
      const note = document.createElement('div');
      note.className = 'cat-crit-note hidden';
      note.textContent = '✎ generates from this criteria, not the name';
      blk.appendChild(note);
    }
  });
  if (!setupIndicatorsWired) {
    setupIndicatorsWired = true;
    const setup = document.getElementById('setup');
    if (setup) setup.addEventListener('input', refreshCriteriaIndicators);
  }
  refreshCriteriaIndicators();
}
function refreshCriteriaIndicators() {
  document.querySelectorAll('.cat-block').forEach(blk => {
    const note = blk.querySelector('.cat-crit-note');
    const nameEl = blk.querySelector('.cat-name');
    const critEl = blk.querySelector('.cat-criteria');
    if (blk.dataset.customId || !nameEl || !critEl) {
      blk.classList.remove('cat-mismatch');
      if (note) note.classList.add('hidden');
      return;
    }
    const name = nameEl.value.trim().toLowerCase();
    const crit = critEl.value.trim().toLowerCase();
    const diff = !!crit && crit !== name;
    blk.classList.toggle('cat-mismatch', diff);
    if (note) note.classList.toggle('hidden', !diff);
  });
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

// Show "N of M topics have cached questions" under the setup buttons.
async function refreshWarmStatus() {
  const el = document.getElementById('warmPoolStatus');
  if (!el) return;
  try {
    const d = await (await fetch('/api/pool/status')).json();
    if (!d || !d.total) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const done = d.cached >= d.total;
    el.textContent = done
      ? `✅ All ${d.total} pooled topics are cached — random games cost no AI tokens.`
      : `⚡ ${d.cached} of ${d.total} pooled topics cached. Pre-generate the rest for token-free play.`;
  } catch (e) { el.classList.add('hidden'); }
}

// Pre-generate question banks. force=false fills only topics without a bank;
// force=true regenerates every pooled topic (e.g. to upgrade older banks).
async function warmPool(force) {
  if (force && !confirm('Regenerate questions for ALL pooled topics? This spends Anthropic tokens for every topic and overwrites their cached banks.')) return;
  const warmBtn = document.getElementById('warmPoolBtn');
  const refreshBtn = document.getElementById('refreshPoolBtn');
  const el = document.getElementById('warmPoolStatus');
  [warmBtn, refreshBtn].forEach(b => { if (b) b.disabled = true; });
  const active = force ? refreshBtn : warmBtn;
  if (active) active.textContent = force ? '⏳ Refreshing…' : '⏳ Pre-generating…';
  const verb = force ? 'Regenerating all banks' : 'Generating question banks';
  if (el) { el.classList.remove('hidden'); el.textContent = verb + ' — this can take a while for many topics…'; }

  // Poll live progress so the host sees "N / M done" instead of just a spinner.
  const poll = setInterval(async () => {
    try {
      const p = await (await fetch('/api/pool/warm/progress')).json();
      if (el && p && p.active && p.total) el.textContent = `${verb} — ${p.done} / ${p.total} done…`;
    } catch (e) {}
  }, 1500);

  try {
    const res = await fetch('/api/pool/warm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!force }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'failed');
    const failedNote = d.failed && d.failed.length ? ` (${d.failed.length} failed: ${d.failed.join(', ')})` : '';
    if (el) el.textContent = d.force
      ? `✅ Refreshed — regenerated ${d.generated} of ${d.total} topics${failedNote}.`
      : `✅ Done — generated ${d.generated} new, ${d.alreadyCached} already cached of ${d.total} topics${failedNote}.`;
  } catch (e) {
    if (el) el.textContent = '⚠️ Could not generate: ' + (e.message || 'error') + '. (Anthropic key/quota?)';
  } finally {
    clearInterval(poll);
    if (warmBtn) { warmBtn.disabled = false; warmBtn.textContent = '⚡ Pre-generate Pool'; }
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '♻️ Refresh All Banks'; }
    refreshWarmStatus();
  }
}

// ── Save / load whole boards ─────────────────────────────────
// Save the fully-configured board from the review screen.
function saveCurrentBoard() {
  const name = (prompt('Name this board (e.g. "Family Game Night"):') || '').trim();
  if (!name) return;
  socket.emit('saveBoard', { name });
}

function openBoardPicker() {
  document.getElementById('boardPicker').classList.remove('hidden');
  renderBoardPicker();
}
function closeBoardPicker() {
  const el = document.getElementById('boardPicker');
  if (el) el.classList.add('hidden');
}

async function renderBoardPicker() {
  const el = document.getElementById('boardPicker');
  if (!el) return;
  let boards = [];
  try { boards = (await (await fetch('/api/boards')).json()).boards || []; } catch (e) {}
  const rows = boards.length ? boards.map(b => {
    const when = b.savedAt ? new Date(b.savedAt).toLocaleDateString() : '';
    const cats = (b.categories || []).slice(0, 6).join(', ');
    return `<div class="bp-row">
      <div class="bp-meta">
        <div class="bp-name">${escHtml(b.name)}</div>
        <div class="bp-sub">${escHtml(cats)}${when ? ' · ' + when : ''}</div>
      </div>
      <button class="btn btn-sm btn-primary" onclick="loadSavedBoard('${escAttr(b.name)}')">Load</button>
      <button class="btn btn-sm btn-secondary" onclick="deleteSavedBoard('${escAttr(b.name)}')" title="Delete">🗑</button>
    </div>`;
  }).join('') : `<p class="subtitle">No saved boards yet. Build a board, then use 💾 Save Board on the review screen.</p>`;
  el.innerHTML = `
    <div class="card bp-card">
      <div class="bp-head"><h2>Saved Boards</h2><button class="btn btn-sm btn-secondary" onclick="closeBoardPicker()">✕ Close</button></div>
      <div class="bp-list">${rows}</div>
    </div>`;
}

function loadSavedBoard(name) {
  if (!confirm(`Load "${name}"? This replaces the current setup and jumps to the review screen.`)) return;
  socket.emit('loadBoard', { name });
}
function deleteSavedBoard(name) {
  if (!confirm(`Delete saved board "${name}"? This can't be undone.`)) return;
  socket.emit('deleteBoard', { name });
}

function render() {
  if (!state) return;

  showScreen(state.phase);

  // Host always has an escape hatch back to setup once a game is underway.
  const so = document.getElementById('hostStartOver');
  if (so) so.classList.toggle('hidden', !(isHost && state.phase !== 'setup' && state.phase !== 'lobby'));

  if (state.phase === 'setup' && isHost && !categoriesPreloaded) {
    categoriesPreloaded = true;
    fetch('/api/categories')
      .then(r => r.json())
      .then(data => {
        categoryPool = data.pool || [];
        const singleNames = document.querySelectorAll('.single-name');
        const doubleNames = document.querySelectorAll('.double-name');
        data.single.forEach((cat, i) => { if (singleNames[i]) singleNames[i].value = cat; });
        data.double.forEach((cat, i) => { if (doubleNames[i]) doubleNames[i].value = cat; });
        refreshCriteriaIndicators();
      });
    refreshWarmStatus();
    // Warn the host if persistent storage isn't configured (custom categories /
    // pool edits would be lost on every redeploy).
    fetch('/api/storage/diag').then(r => r.json()).then(d => {
      const w = document.getElementById('storageWarn');
      if (!w) return;
      if (d && d.useGist === false) {
        w.innerHTML = '⚠ Persistent storage is OFF — custom categories and saved topics will be lost on the next redeploy. Set <strong>GIST_TOKEN</strong> and <strong>GIST_ID</strong> on the Render service to fix.';
        w.classList.remove('hidden');
      } else {
        w.classList.add('hidden');
      }
    }).catch(() => {});
  }

  if (state.phase === 'lobby' || state.phase === 'setup' || state.phase === 'generating') {
    renderLobby();
  }
  if (state.phase === 'setup' && isHost) {
    showScreen('setup');
    ensureCustomButtons();
    ensureSetupIndicators();
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
  if (state.phase === 'review') {
    renderReview();
  }
  if (state.phase === 'final') {
    renderFinal();
  }
  if (state.phase === 'gameover') {
    renderGameOver();
    startGameOverTheme();
  }

  // Tidy up Final/review transient UI state once we leave those phases.
  if (state.phase !== 'review') reviewBuilt = false;
  if (state.phase !== 'final') ensureFinalTicker(false);
  if (state.phase !== 'gameover') stopGameOverTheme();
  if (!state.final) { finalViewSig = ''; finalAudioKey = null; spotBuiltFor = null; stopJingle(); }
}

function showScreen(phase) {
  const map = {
    lobby: 'lobby',
    setup: isHost ? 'setup' : 'lobby',
    generating: 'generating',
    review: 'review',
    single: 'game',
    double: 'game',
    final: 'final',
    gameover: 'gameover',
  };
  const screens = ['landing', 'lobby', 'setup', 'generating', 'review', 'game', 'final', 'gameover'];
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
    cancelSpeech();              // stop browser-voice read-out when the clue clears
    return;
  }
  modal.classList.remove('hidden');

  const q = state.currentQuestion;
  document.getElementById('modalCategory').textContent = q.category;
  document.getElementById('modalValue').textContent = q.isDailyDouble ? 'DAILY DOUBLE' : `$${q.dollarValue}`;
  document.getElementById('modalClue').textContent = q.clue;

  // New question? reset the optimistic buzz flag, stinger a DD, set media once.
  const questionKey = `${q.round}|${q.category}|${q.valueIndex}`;
  if (questionKey !== shownQuestionKey) {
    shownQuestionKey = questionKey;
    buzzPending = false;
    if (q.isDailyDouble) playDailyDoubleStinger();
    const mediaEl = document.getElementById('modalMedia');
    if (q.media) {
      const src = `/api/custommedia/${q.media.catId}/${q.media.qIndex}`;
      mediaEl.innerHTML = q.media.type === 'image'
        ? `<img class="modal-media-img" src="${src}" alt="clue image">`
        : `<audio class="modal-media-aud" controls src="${src}"></audio>`;
    } else {
      mediaEl.innerHTML = '';
    }
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

// ── Final Jeopardy: review screen ─────────────────────────────
let reviewBuilt = false;
let reviewLastContent = '';
let reviewEditTimer = null;

function renderReview() {
  const c = document.getElementById('reviewContent');
  const fj = state.finalJeopardy;

  if (!isHost) {
    reviewBuilt = false;
    c.innerHTML = `
      <div class="card center">
        <h2>Get Ready!</h2>
        <p>The host is reviewing the Final Jeopardy question.<br>The game is about to begin…</p>
      </div>`;
    return;
  }

  // Host editor — built once, then we only repopulate when a regenerate lands.
  if (!reviewBuilt) {
    c.innerHTML = `
      <div class="card review-card review-wide">
        <h2>Review the Board</h2>
        <p class="subtitle">Only you see this. Check each category's clues; regenerate any that came out weak.</p>
        <div id="rvBoard"></div>
      </div>
      <div class="card review-card">
        <h2>Final Jeopardy</h2>
        <label class="rv-label">Category</label>
        <input id="rvCategory" class="rv-input" type="text" maxlength="40" oninput="onReviewEdit()">
        <label class="rv-label">Clue (read aloud to players)</label>
        <textarea id="rvClue" class="rv-input rv-area" rows="3" oninput="onReviewEdit()"></textarea>
        <label class="rv-label">Answer</label>
        <input id="rvAnswer" class="rv-input" type="text" maxlength="120" oninput="onReviewEdit()">
        <div id="rvStatus" class="rv-status hidden"></div>
        <div class="rv-buttons">
          <button id="rvRegen" class="btn btn-secondary" onclick="regenerateFinal()">⟳ Regenerate Final</button>
          <button class="btn btn-secondary" onclick="saveCurrentBoard()" title="Save this whole board (all categories, clues, daily doubles, Final) to reload later">💾 Save Board</button>
          <button id="rvStart" class="btn btn-primary" onclick="beginRounds()">Start Game →</button>
        </div>
      </div>`;
    reviewBuilt = true;
    reviewLastContent = '';
  }

  updateReviewBoard();   // refresh the board clues each broadcast (regenerate, etc.)

  // Repopulate fields from server only when content changed AND we're not typing
  // (so a regenerate refreshes them, but live edits aren't clobbered).
  const sig = fj ? JSON.stringify(fj) : '';
  const active = document.activeElement && document.activeElement.id;
  const typing = active === 'rvCategory' || active === 'rvClue' || active === 'rvAnswer';
  if (fj && sig !== reviewLastContent && !typing) {
    document.getElementById('rvCategory').value = fj.category || '';
    document.getElementById('rvClue').value = fj.clue || '';
    document.getElementById('rvAnswer').value = fj.answer || '';
    reviewLastContent = sig;
  }

  const regenerating = !!state.finalRegenerating;
  const status = document.getElementById('rvStatus');
  const regenBtn = document.getElementById('rvRegen');
  const startBtn = document.getElementById('rvStart');
  if (regenerating) {
    status.classList.remove('hidden');
    status.textContent = '✍️ Writing a new final clue…';
  } else {
    status.classList.add('hidden');
  }
  regenBtn.disabled = regenerating;
  startBtn.disabled = regenerating;
}

// Host-only board review: each category's name + 5 editable clue/answer pairs,
// with per-clue regenerate + per-category regenerate. The clue/answer fields are
// live inputs, so we skip rebuilding while the host is actively typing in one
// (otherwise a broadcast would clobber the caret). Regenerate landings still
// repaint once focus leaves the field / sits on a button.
function updateReviewBoard() {
  const el = document.getElementById('rvBoard');
  if (!el) return;
  const ae = document.activeElement;
  if (ae && el.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;
  const rounds = [['single', 'Single Jeopardy'], ['double', 'Double Jeopardy']];
  el.innerHTML = rounds.map(([round, label]) => {
    const board = state.board && state.board[round];
    if (!board) return '';
    const vals = round === 'single' ? [100, 200, 300, 400, 500] : [200, 400, 600, 800, 1000];
    return `<div class="rv-round"><h3>${label}</h3>` + Object.keys(board).map(name => {
      const regen = !!(state.regenerating && state.regenerating[round + '|' + name]);
      const isCustom = !!(state.customCats && state.customCats[round + '|' + name]);
      const clues = board[name] || [];
      const rows = clues.map((c, i) => {
        const regenOne = !!(state.regeneratingClues && state.regeneratingClues[round + '|' + name + '|' + i]);
        const busy = regen || regenOne;
        const dis = busy ? 'disabled' : '';
        const up = i > 0
          ? `<button class="rv-arrow" onclick="moveClue('${round}','${escAttr(name)}',${i},'up')" title="Make this clue worth less" ${dis}>▲</button>`
          : `<span class="rv-arrow rv-arrow-empty"></span>`;
        const down = i < clues.length - 1
          ? `<button class="rv-arrow" onclick="moveClue('${round}','${escAttr(name)}',${i},'down')" title="Make this clue worth more" ${dis}>▼</button>`
          : `<span class="rv-arrow rv-arrow-empty"></span>`;
        const mediaBadge = c.media ? `<span class="rv-media-badge">★ ${c.media.type} DD</span>` : '';
        // Single-clue regenerate: AI categories only, and not a media daily double.
        const regenBtn = (!isCustom && !c.media)
          ? `<button class="rv-regen-one" onclick="regenerateClue('${round}','${escAttr(name)}',${i})" title="Regenerate just this clue" ${dis}>${regenOne ? '…' : '⟳'}</button>`
          : `<span class="rv-regen-one rv-regen-empty"></span>`;
        return `<div class="rv-clue ${regenOne ? 'rv-dim' : ''}">
          <span class="rv-clue-val">$${vals[i]}</span>
          <div class="rv-clue-fields" data-round="${round}" data-name="${escHtml(name)}" data-index="${i}">
            <textarea class="rv-clue-edit rv-clue-q-edit" rows="2" maxlength="600"
              placeholder="Clue" oninput="onClueEdit(this)" onblur="onClueBlur(this)" ${dis}>${escHtml(c.clue || '')}</textarea>
            ${mediaBadge}
            <input class="rv-clue-edit rv-clue-a-edit" type="text" maxlength="200"
              placeholder="Answer" value="${escHtml(c.answer || '')}" oninput="onClueEdit(this)" onblur="onClueBlur(this)" ${dis}>
          </div>
          <span class="rv-arrows">${up}${down}</span>
          ${regenBtn}
        </div>`;
      }).join('');
      const headBtn = isCustom
        ? `<span class="rv-custom-tag">✎ custom</span>`
        : `<button class="btn btn-sm btn-secondary" onclick="regenerateCategory('${round}','${escAttr(name)}')" ${regen ? 'disabled' : ''}>${regen ? '…regenerating' : '⟳ Regenerate all'}</button>`;
      return `<div class="rv-cat">
        <div class="rv-cat-head">
          <span class="rv-cat-name">${escHtml(name)}</span>
          ${headBtn}
        </div>
        <div class="rv-clues ${regen ? 'rv-dim' : ''}">${rows}</div>
      </div>`;
    }).join('') + `</div>`;
  }).join('');
}

function regenerateCategory(round, name) { socket.emit('regenerateCategory', { round, name }); }
function moveClue(round, name, index, dir) { socket.emit('moveClue', { round, name, index, dir }); }

// ── Per-clue editing (debounced) ─────────────────────────────
// The host can retype any clue/answer; we debounce-emit `editClue`, and flush
// immediately on blur or before a regenerate so nothing is lost.
let clueEditTimer = null, clueEditEl = null;
function clueFieldsPayload(fieldEl) {
  const wrap = fieldEl.closest('.rv-clue-fields');
  if (!wrap) return null;
  const q = wrap.querySelector('.rv-clue-q-edit');
  const a = wrap.querySelector('.rv-clue-a-edit');
  return {
    round: wrap.dataset.round,
    name: wrap.dataset.name,
    index: Number(wrap.dataset.index),
    clue: q ? q.value : '',
    answer: a ? a.value : '',
  };
}
function onClueEdit(fieldEl) {
  clueEditEl = fieldEl;
  if (clueEditTimer) clearTimeout(clueEditTimer);
  clueEditTimer = setTimeout(flushClueEdit, 500);
}
function flushClueEdit() {
  if (clueEditTimer) { clearTimeout(clueEditTimer); clueEditTimer = null; }
  if (!clueEditEl) return;
  const payload = clueFieldsPayload(clueEditEl);
  clueEditEl = null;
  if (payload) socket.emit('editClue', payload);
}
function onClueBlur() { flushClueEdit(); }
function regenerateClue(round, name, index) {
  flushClueEdit();   // persist any pending text edit before re-rolling this clue
  socket.emit('regenerateClue', { round, name, index });
}

function currentReviewFields() {
  return {
    category: (document.getElementById('rvCategory') || {}).value || '',
    clue: (document.getElementById('rvClue') || {}).value || '',
    answer: (document.getElementById('rvAnswer') || {}).value || '',
  };
}

function onReviewEdit() {
  if (reviewEditTimer) clearTimeout(reviewEditTimer);
  reviewEditTimer = setTimeout(() => {
    const f = currentReviewFields();
    socket.emit('editFinal', f);
    // Keep our signature aligned with the server's trimmed echo so it won't
    // try to repopulate the fields we're editing.
    reviewLastContent = JSON.stringify({ category: f.category.trim(), clue: f.clue.trim(), answer: f.answer.trim() });
  }, 400);
}

function regenerateFinal() {
  const cat = (document.getElementById('rvCategory') || {}).value || '';
  socket.emit('regenerateFinal', { category: cat });
}

function beginRounds() {
  if (reviewEditTimer) { clearTimeout(reviewEditTimer); reviewEditTimer = null; }
  socket.emit('editFinal', currentReviewFields());   // flush any pending edit
  socket.emit('beginRounds');
}

// ── Final Jeopardy: round play ────────────────────────────────
let finalViewSig = '';
let finalTicker = null;
let finalAnswerTimer = null;
let spotBuiltFor = null;        // which contestant's reveal skeleton is currently built
let spotJudgedShown = false;    // so the score count-up animation only runs once

function ensureFinalTicker(active) {
  if (active && !finalTicker) finalTicker = setInterval(tickFinal, 100);
  else if (!active && finalTicker) { clearInterval(finalTicker); finalTicker = null; }
}

function myFinalRole(f) {
  if (isHost) return 'host';
  return f.eligible.includes(myId) ? 'player' : 'spectator';
}

function renderFinal() {
  const f = state.final;
  if (!f) return;
  if (f.stage !== 'answer') { stopJingle(); cancelSpeech(); }

  const role = myFinalRole(f);
  const wagerLocked = (f.stage === 'wager' && role === 'player')
    ? Object.prototype.hasOwnProperty.call(f.wagers, myId) : '';
  const sig = [f.stage, role, f.answerClosed, f.crowned, wagerLocked].join('|');
  if (sig !== finalViewSig) { buildFinalView(f, role); finalViewSig = sig; }
  updateFinalView(f, role);

  if (f.stage === 'answer') { scheduleFinalAudio(); ensureFinalTicker(true); }
  else ensureFinalTicker(false);
}

function buildFinalView(f, role) {
  spotBuiltFor = null;            // skeleton is being rebuilt → invalidate spotlight cache
  const c = document.getElementById('finalContent');
  const myScore = (state.players[myId] && state.players[myId].score) || 0;
  let body = '';

  if (f.stage === 'wager') {
    if (role === 'host') {
      body = `<div class="card final-card">
        <p class="subtitle">Players are placing secret wagers.</p>
        <div id="fWagerList"></div>
        <button class="btn btn-primary" onclick="startFinalClue()">Reveal Clue &amp; Start Timer →</button>
      </div>`;
    } else if (role === 'player') {
      const locked = Object.prototype.hasOwnProperty.call(f.wagers, myId);
      const max = Math.max(0, myScore);
      body = locked
        ? `<div class="card final-card center"><h3>Wager locked 🔒</h3><p>Waiting for the clue…</p></div>`
        : `<div class="card final-card">
            <p>Your score: <strong>$${myScore.toLocaleString()}</strong></p>
            <label class="rv-label">Your secret wager (0 – $${max.toLocaleString()})</label>
            <input id="fWagerInput" class="rv-input" type="number" min="0" max="${max}" value="0">
            <button class="btn btn-primary" onclick="submitFinalWager()">Lock Wager 🔒</button>
          </div>`;
    } else {
      body = `<div class="card final-card center"><h3>Final Jeopardy</h3><p>You're sitting this one out (need a positive score). Enjoy the show!</p></div>`;
    }
  } else if (f.stage === 'answer') {
    let role_body = '';
    if (role === 'host') {
      role_body = `
        <div class="final-answer-host">Correct response: ${escHtml(f.answer)}</div>
        <div id="fAnsweredList"></div>
        <button id="fRevealBtn" class="btn btn-primary hidden" onclick="beginFinalReveal()">Reveal Answers →</button>`;
    } else if (role === 'player') {
      // Input stays locked until the clue is finished AND the timer/music start.
      const canType = !f.answerClosed && f.jingleStart != null && serverNow() >= f.jingleStart;
      role_body = `
        <label class="rv-label">Your response</label>
        <div id="fAnswerHint" class="final-hint ${canType ? 'hidden' : ''}">🔒 Listen to the clue…</div>
        <input id="fAnswerInput" class="rv-input" type="text" maxlength="200" placeholder="What is…?" oninput="onFinalAnswerInput()" ${canType ? '' : 'disabled'}>
        <div id="fTimeUp" class="final-timeup ${f.answerClosed ? '' : 'hidden'}">⏰ TIME'S UP</div>`;
    } else {
      role_body = `<p class="subtitle">Players are answering…</p>`;
    }
    body = `<div class="card final-card">
      <div id="fClue" class="final-clue hidden">${escHtml(f.clue)}</div>
      <div id="fCountdown" class="final-countdown"></div>
      ${role_body}
    </div>`;
  } else if (f.stage === 'reveal') {
    body = `<div class="card final-card final-spotlight-card">
      <div class="final-answer-reveal">Correct response: ${escHtml(f.answer)}</div>
      <div id="fSpotlight"></div>
      <div id="fSpotControls" class="spot-controls"></div>
    </div>`;
  }

  c.innerHTML = `
    <div class="final-header">
      <div class="final-title">FINAL JEOPARDY</div>
      <div id="fCategory" class="final-cat"></div>
    </div>
    ${body}`;

  // Set initial values on freshly-built inputs (without clobbering on updates).
  const wi = document.getElementById('fWagerInput');
  if (wi && f.wagers[myId] != null) wi.value = f.wagers[myId];
  const ai = document.getElementById('fAnswerInput');
  if (ai && f.answers[myId] != null) ai.value = f.answers[myId];
}

function updateFinalView(f, role) {
  const catEl = document.getElementById('fCategory');
  if (catEl) catEl.textContent = f.category;

  if (f.stage === 'wager' && role === 'host') {
    const list = document.getElementById('fWagerList');
    if (list) {
      const done = f.eligible.filter(id => Object.prototype.hasOwnProperty.call(f.wagers, id)).length;
      const rows = f.eligible.map(id => {
        const p = state.players[id]; if (!p) return '';
        const ok = Object.prototype.hasOwnProperty.call(f.wagers, id);
        return `<div class="final-row"><span>${avatar(id, p, 24)} ${escHtml(p.name)}</span><span>${ok ? '✓ wagered' : '…'}</span></div>`;
      }).join('');
      list.innerHTML = `<div class="final-progress">${done} / ${f.eligible.length} wagered</div>${rows}`;
    }
  }

  if (f.stage === 'answer' && role === 'host') {
    const al = document.getElementById('fAnsweredList');
    if (al) {
      const done = f.eligible.filter(id => f.answered && f.answered[id]).length;
      al.innerHTML = `<div class="final-progress">${done} / ${f.eligible.length} answered</div>`;
    }
    const rb = document.getElementById('fRevealBtn');
    if (rb) rb.classList.toggle('hidden', !f.answerClosed);
  }

  if (f.stage === 'reveal') {
    const order = (f.revealOrder && f.revealOrder.length) ? f.revealOrder : f.eligible;
    const idx = Math.min(f.spotlight || 0, order.length - 1);
    const id = order[idx];
    const p = state.players[id];
    const sp = document.getElementById('fSpotlight');
    if (p && sp) {
      const r = f.reveal[id] || {};
      const wager = f.wagers[id] || 0;
      const judged = r.judged;                       // 'correct' | 'wrong' | null
      // Reconstruct the pre-wager score so we can count UP to the new total.
      const curScore = p.score;
      const oldScore = judged === 'correct' ? curScore - wager
                     : judged === 'wrong'   ? curScore + wager : curScore;
      const ansText = (f.answers[id] && f.answers[id].trim()) ? escHtml(f.answers[id]) : '<em>(no response)</em>';

      // Build the skeleton ONCE per contestant; afterwards we only un-hide rows
      // so each reveal animates on its own (identical on every screen).
      if (spotBuiltFor !== id + '@' + idx) {
        spotBuiltFor = id + '@' + idx;
        spotJudgedShown = false;
        sp.innerHTML = `
          <div class="spot-progress">Contestant ${idx + 1} of ${order.length}</div>
          <div class="spot-avatar">${avatar(id, p, 120)}</div>
          <div class="spot-name">${escHtml(p.name)}</div>
          <div class="spot-stat">
            <div class="spot-label" id="spotScoreLabel">Score</div>
            <div class="spot-num spot-score" id="spotScore">$${oldScore.toLocaleString()}</div>
          </div>
          <div class="spot-stat hidden" id="spotWagerRow">
            <div class="spot-label">Wager</div>
            <div class="spot-num spot-wager-num">$${wager.toLocaleString()}</div>
          </div>
          <div class="spot-stat hidden" id="spotAnswerRow">
            <div class="spot-label">Answer</div>
            <div class="spot-answer">${ansText}</div>
          </div>
          <div class="spot-result hidden" id="spotResult"></div>`;
      }

      // Incremental reveals (CSS animates each as it un-hides).
      if (r.wager) { const el = document.getElementById('spotWagerRow'); if (el) el.classList.remove('hidden'); }
      if (r.answer) { const el = document.getElementById('spotAnswerRow'); if (el) el.classList.remove('hidden'); }
      if (judged && !spotJudgedShown) {
        spotJudgedShown = true;
        const res = document.getElementById('spotResult');
        if (res) { res.textContent = judged === 'correct' ? '✓ CORRECT' : '✗ INCORRECT'; res.className = `spot-result spot-${judged}`; }
        const lbl = document.getElementById('spotScoreLabel');
        if (lbl) lbl.textContent = 'New Score';
        if (oldScore !== curScore) animateNumber(document.getElementById('spotScore'), oldScore, curScore, 900);
      }

      const ctrls = document.getElementById('fSpotControls');
      if (ctrls) {
        if (!isHost) ctrls.innerHTML = '<div class="spot-waiting">Watching…</div>';
        else if (!r.wager) ctrls.innerHTML = `<button class="btn btn-primary" onclick="revealFinalWager('${id}')">Reveal Wager</button>`;
        else if (!r.answer) ctrls.innerHTML = `<button class="btn btn-primary" onclick="revealFinalAnswer('${id}')">Reveal Answer</button>`;
        else if (!judged) ctrls.innerHTML =
          `<button class="award-btn award-correct" onclick="judgeFinal('${id}', true)">✓ Correct</button>
           <button class="award-btn award-wrong" onclick="judgeFinal('${id}', false)">✗ Wrong</button>`;
        else if (idx < order.length - 1) ctrls.innerHTML = `<button class="btn btn-primary" onclick="nextFinalContestant()">Next Contestant →</button>`;
        else ctrls.innerHTML = `<button class="btn btn-primary" onclick="crownWinner()">👑 Crown the Winner</button>`;
      }
    }
  }
}

// Ease-out count-up animation for the dramatic score reveal.
function animateNumber(el, from, to, ms) {
  if (!el) return;
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = '$' + Math.round(from + (to - from) * eased).toLocaleString();
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Lightweight ticker: reveals the clue when speech starts, counts the timer
// down, and locks the input at the deadline.
function tickFinal() {
  if (!state || state.phase !== 'final' || !state.final) { ensureFinalTicker(false); return; }
  const f = state.final;
  if (f.stage !== 'answer') { ensureFinalTicker(false); return; }
  const now = serverNow();

  const clueEl = document.getElementById('fClue');
  if (clueEl) clueEl.classList.toggle('hidden', !(f.audioStartTime != null && now >= f.audioStartTime));

  const cd = document.getElementById('fCountdown');
  if (f.answerDeadline != null) {
    const started = f.jingleStart != null && now >= f.jingleStart;
    const remain = Math.max(0, f.answerDeadline - now);
    if (cd) cd.textContent = started ? Math.ceil(remain / 1000) + 's' : '';

    const input = document.getElementById('fAnswerInput');
    const hint = document.getElementById('fAnswerHint');
    const closed = f.answerClosed || remain <= 0;

    if (started && !closed && input && input.disabled) {
      // Clue done + timer running → unlock the input and focus it.
      input.disabled = false;
      if (hint) hint.classList.add('hidden');
      try { input.focus(); } catch (e) {}
    }
    if (closed) {
      if (input) input.disabled = true;
      if (hint) hint.classList.add('hidden');
      const tu = document.getElementById('fTimeUp');
      if (tu) tu.classList.remove('hidden');
      stopJingle();
    }
  }
}

// ── Host Actions ──────────────────────────────────────────────
function collectCategories(blockSel) {
  return Array.from(document.querySelectorAll(blockSel)).map(blk => {
    if (blk.dataset.customId) return { customId: blk.dataset.customId, name: blk.dataset.customName || '' };
    const nameEl = blk.querySelector('.cat-name');
    const critEl = blk.querySelector('.cat-criteria');
    const name = ((nameEl && nameEl.value) || '').trim();
    let criteria = ((critEl && critEl.value) || '').trim();
    if (!criteria) criteria = name;            // criteria defaults to the name
    return { name, criteria };
  }).filter(c => c.customId || c.name);
}
function firstDuplicateName(list) {
  const seen = new Set();
  for (const c of list) { const k = c.name.toLowerCase(); if (seen.has(k)) return c.name; seen.add(k); }
  return null;
}

function submitCategories() {
  try {
    const single = collectCategories('.single-block');
    const double = collectCategories('.double-block');
    if (single.length < 1) return alert('Enter at least 1 Single Jeopardy category name');
    if (double.length < 1) return alert('Enter at least 1 Double Jeopardy category name');
    // Board is keyed by name, so names must be unique within a round.
    const dup = firstDuplicateName(single) || firstDuplicateName(double);
    if (dup) return alert(`Duplicate category name: "${dup}". Category names must be unique.`);
    const elVal = (id, d) => { const el = document.getElementById(id); return el ? el.value : d; };
    const enforceEarlyPenalty = (() => { const el = document.getElementById('enforcePenalty'); return el ? el.checked : true; })();
    const buzzTimeoutMs = (parseInt(elVal('buzzSeconds', '8'), 10) || 8) * 1000;
    const finalAnswerMs = (parseInt(elVal('finalSeconds', '30'), 10) || 30) * 1000;
    const voiceMode = elVal('voiceMode', 'elevenlabs') || 'elevenlabs';
    const finalCategory = (elVal('finalCat', '') || '').trim();
    const finalClue = (elVal('finalClueInput', '') || '').trim();
    const finalAnswer = (elVal('finalAnswerInput', '') || '').trim();
    if (finalClue && !finalAnswer) return alert('Enter the Final answer for your custom question (or clear the question to auto-generate).');
    if (finalAnswer && !finalClue) return alert('Enter the Final question for your answer (or clear both to auto-generate).');
    socket.emit('setCategories', {
      singleCategories: single,
      doubleCategories: double,
      finalCategory,
      finalClue,
      finalAnswer,
      settings: { enforceEarlyPenalty, buzzTimeoutMs, finalAnswerMs, voiceMode },
    });
  } catch (e) {
    alert('Could not start generation: ' + (e && e.message ? e.message : e));
  }
}

// ── Custom categories: setup-slot picker ──────────────────────
let customList = [];
function loadCustomList() {
  return fetch('/api/custom').then(r => r.json()).then(d => { customList = d.categories || []; return customList; }).catch(() => customList);
}
// Add a ★ "use custom category" button to each setup block (once).
function ensureCustomButtons() {
  document.querySelectorAll('.cat-block').forEach(blk => {
    const row = blk.querySelector('.cat-row');
    if (row && !row.querySelector('.cat-custom-btn')) {
      const b = document.createElement('button');
      b.className = 'btn-reroll cat-custom-btn';
      b.title = 'Use a custom category';
      b.textContent = '★';
      b.onclick = () => openCustomPicker(blk);
      row.appendChild(b);
    }
  });
}
function closeCustomPickers() { document.querySelectorAll('.cat-custom-dd').forEach(e => e.remove()); }
function openCustomPicker(blk) {
  const existing = blk.querySelector('.cat-custom-dd');
  closeCustomPickers();
  if (existing) return;                       // toggle off
  loadCustomList().then(() => {
    if (!customList.length) {
      if (confirm('No custom categories yet. Open the editor to create one?')) openCustomEditor();
      return;
    }
    const dd = document.createElement('div');
    dd.className = 'cat-custom-dd';
    dd.innerHTML = customList.map(c =>
      `<div class="cat-custom-opt" data-id="${c.id}">★ ${escHtml(c.name)} <small>(${c.questions.length})</small></div>`).join('');
    dd.querySelectorAll('.cat-custom-opt').forEach(opt =>
      opt.onclick = () => { applyCustomToBlock(blk, opt.dataset.id); closeCustomPickers(); });
    blk.appendChild(dd);
  });
}
function applyCustomToBlock(blk, id) {
  const cat = customList.find(c => c.id === id);
  if (!cat) return;
  blk.dataset.customId = cat.id;
  blk.dataset.customName = cat.name;
  blk.querySelector('.cat-row').style.display = 'none';
  const crit = blk.querySelector('.cat-criteria'); if (crit) crit.style.display = 'none';
  let chip = blk.querySelector('.cat-chip');
  if (!chip) { chip = document.createElement('div'); chip.className = 'cat-chip'; blk.appendChild(chip); }
  chip.innerHTML = `★ ${escHtml(cat.name)} <button class="cat-chip-x" title="Use AI instead">✕</button>`;
  chip.querySelector('.cat-chip-x').onclick = () => clearCustomFromBlock(blk);
  refreshCriteriaIndicators();
}
function clearCustomFromBlock(blk) {
  delete blk.dataset.customId; delete blk.dataset.customName;
  const chip = blk.querySelector('.cat-chip'); if (chip) chip.remove();
  blk.querySelector('.cat-row').style.display = '';
  const crit = blk.querySelector('.cat-criteria'); if (crit) crit.style.display = '';
  refreshCriteriaIndicators();
}

// ── Custom category editor ────────────────────────────────────
let editingCat = null;   // { id?, name, questions: [{clue, answer, media, _dataUrl, _missing}] }
function blankQ() { return { clue: '', answer: '', media: null, _dataUrl: null }; }

function openCustomEditor() {
  loadCustomList().then(() => { editingCat = null; renderCustomEditor(); document.getElementById('customEditor').classList.remove('hidden'); });
}
function closeCustomEditor() { document.getElementById('customEditor').classList.add('hidden'); editingCat = null; }
function backToCustomList() { editingCat = null; renderCustomEditor(); }
function newCustomCat() { editingCat = { name: '', questions: [blankQ(), blankQ(), blankQ(), blankQ(), blankQ()] }; renderCustomEditor(); }

function editCustomCat(id) {
  const cat = customList.find(c => c.id === id);
  if (!cat) return;
  editingCat = { id: cat.id, name: cat.name, questions: cat.questions.map(q => ({
    clue: q.clue, answer: q.answer, media: q.media ? { type: q.media.type, name: q.media.name } : null, _dataUrl: null,
  })) };
  renderCustomEditor();
  // Pull existing media binaries back so re-saving keeps indexes aligned.
  editingCat.questions.forEach((q, i) => {
    if (!q.media) return;
    fetch(`/api/custommedia/${cat.id}/${i}`)
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blobToDataUrl).then(url => { q._dataUrl = url; q._missing = false; renderCustomEditor(); })
      .catch(() => { q._missing = true; renderCustomEditor(); });
  });
}
function blobToDataUrl(blob) { return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); }); }

function syncEditorFromDom() {
  if (!editingCat) return;
  const nameEl = document.getElementById('ceName');
  if (nameEl) editingCat.name = nameEl.value;
  editingCat.questions.forEach((q, i) => {
    const ce = document.getElementById('ceClue' + i), ae = document.getElementById('ceAns' + i);
    if (ce) q.clue = ce.value;
    if (ae) q.answer = ae.value;
  });
}
function addCustomQ() { syncEditorFromDom(); editingCat.questions.push(blankQ()); renderCustomEditor(); }
function removeCustomQ(i) { syncEditorFromDom(); editingCat.questions.splice(i, 1); renderCustomEditor(); }
function clearMedia(i) { syncEditorFromDom(); const q = editingCat.questions[i]; q.media = null; q._dataUrl = null; q._missing = false; renderCustomEditor(); }

function attachMedia(i, type) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = type === 'image' ? 'image/*' : 'audio/*';
  input.onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (type === 'image') downscaleImageToDataUrl(file, (url) => setMedia(i, 'image', file.name, url));
    else { const r = new FileReader(); r.onload = () => setMedia(i, 'audio', file.name, r.result); r.readAsDataURL(file); }
  };
  input.click();
}
function setMedia(i, type, name, dataUrl) {
  syncEditorFromDom();
  const q = editingCat.questions[i];
  q.media = { type, name }; q._dataUrl = dataUrl; q._missing = false;
  renderCustomEditor();
}
function downscaleImageToDataUrl(file, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 800;
      const s = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function renderCustomEditor() {
  const el = document.getElementById('customEditor');
  if (!el) return;
  if (!editingCat) {
    const items = customList.length ? customList.map(c =>
      `<div class="ce-listrow"><span>${escHtml(c.name)} <small>(${c.questions.length} Qs${c.questions.some(q => q.media) ? ', media' : ''})</small></span>
        <span><button class="btn btn-sm btn-secondary" onclick="editCustomCat('${c.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCustomCat('${c.id}','${escAttr(c.name)}')">Delete</button></span></div>`).join('')
      : '<p class="subtitle">No custom categories yet — create one below.</p>';
    el.innerHTML = `<div class="ce-panel">
      <div class="ce-head"><h2>Custom Categories</h2><button class="btn btn-sm btn-secondary" onclick="closeCustomEditor()">✕ Close</button></div>
      <div class="ce-list">${items}</div>
      <button class="btn btn-primary" onclick="newCustomCat()">+ New Category</button>
    </div>`;
    return;
  }
  const rows = editingCat.questions.map((q, i) => {
    let preview = '';
    if (q.media) {
      const src = q._dataUrl || ('/api/custommedia/' + (editingCat.id || '') + '/' + i);
      if (q._missing) preview = `<span class="ce-missing">⚠ media missing — re-attach</span>`;
      else if (q.media.type === 'image') preview = `<img class="ce-mediaimg" src="${src}">`;
      else preview = `<audio class="ce-mediaaud" controls src="${src}"></audio>`;
    }
    return `<div class="ce-q">
      <div class="ce-qhead">Question ${i + 1}${q.media ? ' <span class="ce-ddbadge">★ media Daily Double</span>' : ''}
        <button class="ce-del" onclick="removeCustomQ(${i})" title="Remove question">🗑</button></div>
      <textarea id="ceClue${i}" class="rv-input rv-area" rows="2" placeholder="Clue (a statement)">${escHtml(q.clue)}</textarea>
      <input id="ceAns${i}" class="rv-input" type="text" placeholder="Answer (What is …?)" value="${escHtml(q.answer)}">
      <div class="ce-media">
        <button class="btn btn-sm btn-secondary" onclick="attachMedia(${i},'image')">🖼 Image</button>
        <button class="btn btn-sm btn-secondary" onclick="attachMedia(${i},'audio')">🔊 Audio</button>
        ${q.media ? `<button class="btn btn-sm btn-danger" onclick="clearMedia(${i})">Remove media</button>` : ''}
        ${preview}
      </div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="ce-panel">
    <div class="ce-head"><h2>${editingCat.id ? 'Edit' : 'New'} Custom Category</h2><button class="btn btn-sm btn-secondary" onclick="backToCustomList()">‹ Back</button></div>
    <label class="rv-label">Category name</label>
    <input id="ceName" class="rv-input" type="text" maxlength="60" value="${escHtml(editingCat.name)}" placeholder="e.g. Movie Quotes">
    <div class="ce-questions">${rows}</div>
    <div class="ce-actions">
      <button class="btn btn-secondary" onclick="addCustomQ()">+ Add another question</button>
      <button class="btn btn-primary" onclick="saveCustomCat()">💾 Save Category</button>
    </div>
    <p class="subtitle">Attaching an image or audio clip makes that question this category's Daily Double. Need at least 5 complete questions.</p>
  </div>`;
}

function saveCustomCat() {
  syncEditorFromDom();
  const name = (editingCat.name || '').trim();
  if (!name) return alert('Enter a category name.');
  const qs = editingCat.questions.filter(q => (q.clue || '').trim() && (q.answer || '').trim());
  if (qs.length < 5) return alert('A custom category needs at least 5 complete questions (clue + answer).');
  const payload = { category: { id: editingCat.id, name, questions: qs.map(q => ({
    clue: q.clue.trim(), answer: q.answer.trim(), media: q.media ? { type: q.media.type, name: q.media.name } : null,
  })) } };
  fetch('/api/custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    .then(r => r.json())
    .then(async (res) => {
      if (res.error) { alert('Save failed: ' + res.error); return; }
      const saved = res.category;
      // Upload media binaries for questions that have one loaded, keyed by final index.
      for (let idx = 0; idx < qs.length; idx++) {
        if (!qs[idx]._dataUrl) continue;
        await new Promise((resolve) => {
          socket.emit('uploadCustomMedia', { catId: saved.id, qIndex: idx, dataUrl: qs[idx]._dataUrl }, (ack) => {
            if (ack && ack.tooBig) alert(`Media for question ${idx + 1} is too large and was not saved.`);
            resolve();
          });
          setTimeout(resolve, 8000);
        });
      }
      customList = res.categories || customList;
      editingCat = null;
      renderCustomEditor();
      alert('Custom category saved!');
    })
    .catch(() => alert('Save failed.'));
}

function deleteCustomCat(id, name) {
  if (!confirm(`Delete custom category "${name}"?`)) return;
  fetch('/api/custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }) })
    .then(r => r.json()).then(res => { customList = res.categories || []; renderCustomEditor(); }).catch(() => alert('Delete failed.'));
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

// Always-available host reset: clears the current game and returns to setup.
function startOver() {
  if (!confirm('Start over? This clears the current game and takes you back to question setup.')) return;
  socket.emit('resetGame');
}

function submitWager(max) {
  const input = document.getElementById('wagerInput');
  let wager = parseInt(input.value, 10);
  if (isNaN(wager) || wager < 5) wager = 5;
  if (wager > max) wager = max;
  socket.emit('dailyDoubleWager', { wager });
}

// ── Final Jeopardy actions ────────────────────────────────────
function submitFinalWager() {
  const el = document.getElementById('fWagerInput');
  if (!el) return;
  const max = state.players[myId] ? Math.max(0, state.players[myId].score) : 0;
  let w = parseInt(el.value, 10);
  if (isNaN(w) || w < 0) w = 0;
  if (w > max) w = max;
  socket.emit('submitFinalWager', { wager: w });
}

function onFinalAnswerInput() {
  if (finalAnswerTimer) clearTimeout(finalAnswerTimer);
  finalAnswerTimer = setTimeout(() => {
    const el = document.getElementById('fAnswerInput');
    if (el) socket.emit('submitFinalAnswer', { answer: el.value });
  }, 300);
}

function startFinalClue() {
  if (!confirm('Reveal the clue and start the timer? Wagers will lock.')) return;
  socket.emit('startFinalClue');
}
function beginFinalReveal() { socket.emit('beginFinalReveal'); }
function revealFinalAnswer(playerId) { socket.emit('revealFinalAnswer', { playerId }); }
function revealFinalWager(playerId) { socket.emit('revealFinalWager', { playerId }); }
function judgeFinal(playerId, correct) { socket.emit('judgeFinal', { playerId, correct }); }
function nextFinalContestant() { socket.emit('nextFinalContestant'); }
function crownWinner() { socket.emit('crownWinner'); }

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
