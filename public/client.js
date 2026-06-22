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
let buzzState = 'ready';      // ready | buzzed | early | locked
let activeQuestionKey = null; // detects when a new question starts
let clueAudio = null;

// Read the clue aloud (host only). Tries ElevenLabs first (reliable 'ended'
// event), falls back to the browser speech engine. Emits 'readingFinished'
// exactly once when reading completes.
async function speakClue(text) {
  let finished = false;
  function done() {
    if (finished) return;
    finished = true;
    socket.emit('readingFinished');
  }

  if (!isHost) return;

  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('tts unavailable');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (clueAudio) { clueAudio.pause(); clueAudio = null; }
    clueAudio = new Audio(url);
    clueAudio.onended = () => { URL.revokeObjectURL(url); done(); };
    clueAudio.onerror = () => { URL.revokeObjectURL(url); done(); };
    await clueAudio.play();
    return;
  } catch (err) {
    // Fall back to browser speech synthesis
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.9;
    utter.pitch = 1;
    utter.onend = done;
    const fallbackMs = Math.ceil(text.length / 12) * 1000 + 2500;
    setTimeout(done, fallbackMs);
    window.speechSynthesis.speak(utter);
  } else {
    // No speech available — open buzzing after a short estimated delay
    setTimeout(done, Math.ceil(text.length / 12) * 1000 + 1000);
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
  // Three short descending buzzes — "nobody got it"
  const ctx = getAudioCtx();
  const t = ctx.currentTime;
  playBuzz(t,        0.18, 180);
  playBuzz(t + 0.28, 0.18, 150);
  playBuzz(t + 0.56, 0.30, 110);
}

// ── Connection ──────────────────────────────────────────────
function unlockAudio() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
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

socket.on('joined', ({ id }) => {
  myId = id;
});

socket.on('state', (s) => {
  state = s;
  if (myId) render();
});

// Result of my own buzz attempt
socket.on('buzzResult', ({ status, unlockAt }) => {
  if (status === 'accepted') {
    buzzState = 'buzzed';
  } else if (status === 'early') {
    buzzState = 'early';   // locked until 250ms after reading; re-enabled by 'readingDone'
  } else if (status === 'locked') {
    buzzState = 'locked';
    scheduleUnlock(unlockAt);
  }
  updateBuzzButton();
});

// Reading finished — unlock penalized players 250ms later
socket.on('readingDone', ({ unlockAt, lockedIds }) => {
  if (buzzState === 'early' && lockedIds.includes(myId)) {
    buzzState = 'locked';
    scheduleUnlock(unlockAt);
  }
  updateBuzzButton();
});

// Nobody buzzed within 3s of reading finishing
socket.on('questionTimeout', () => {
  playWrongSound();
});

socket.on('error', ({ message }) => {
  alert('Error: ' + message);
});

let unlockTimer = null;
function scheduleUnlock(unlockAt) {
  if (unlockTimer) clearTimeout(unlockTimer);
  const delay = Math.max(0, unlockAt - Date.now());
  unlockTimer = setTimeout(() => {
    if (buzzState === 'locked') {
      buzzState = 'ready';
      updateBuzzButton();
    }
  }, delay);
}

function updateBuzzButton() {
  const btn = document.getElementById('buzzBtn');
  if (!btn) return;
  // Hidden unless there's an active question with buzzing open
  if (!state || !state.currentQuestion || !state.buzzOpen) {
    btn.classList.add('hidden');
    return;
  }
  // If I'm already locked in as a buzzer, show buzzed state
  const iAmBuzzer = state.buzzers && state.buzzers.find(b => b.id === myId);
  btn.classList.remove('hidden');
  if (iAmBuzzer || buzzState === 'buzzed') {
    btn.disabled = true; btn.textContent = 'BUZZED!';
  } else if (buzzState === 'early') {
    btn.disabled = true; btn.textContent = 'TOO EARLY!';
  } else if (buzzState === 'locked') {
    btn.disabled = true; btn.textContent = 'WAIT…';
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
  const input = btn.previousElementSibling;
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
  const players = Object.values(state.players || {});
  document.getElementById('lobbyContent').innerHTML = `
    <h2>Waiting for Host to Start</h2>
    <p style="color:#aaa;margin-bottom:8px">Players joined:</p>
    <div class="player-list">
      ${players.map(p => `<div class="player-chip" style="background:${p.color}">${escHtml(p.name)}</div>`).join('')}
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
  const players = Object.values(state.players || {});
  const controlPlayer = state.boardControl ? state.players[state.boardControl] : null;
  document.getElementById('scoreboard').innerHTML =
    (controlPlayer ? `<div class="control-chip" style="border-color:${controlPlayer.color}">🎯 ${escHtml(controlPlayer.name)}</div>` : '') +
    players
      .filter(p => !p.disconnected)
      .sort((a,b) => b.score - a.score)
      .map(p => `<div class="score-chip" style="background:${p.color}">${escHtml(p.name)}: $${p.score.toLocaleString()}</div>`)
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
    return;
  }
  modal.classList.remove('hidden');

  const q = state.currentQuestion;
  document.getElementById('modalCategory').textContent = q.category;
  document.getElementById('modalValue').textContent = q.isDailyDouble ? 'DAILY DOUBLE' : `$${q.dollarValue}`;
  document.getElementById('modalClue').textContent = q.clue;

  // New question? reset my buzz state and (host) start reading aloud
  const questionKey = `${q.round}|${q.category}|${q.valueIndex}`;
  if (questionKey !== activeQuestionKey) {
    activeQuestionKey = questionKey;
    buzzState = 'ready';
    if (isHost) speakClue(q.clue);
  }

  const hasTopBuzzer = state.buzzers && state.buzzers.length > 0;

  // Reading status indicator (hidden once someone has buzzed)
  const readingStatus = document.getElementById('readingStatus');
  if (!hasTopBuzzer) {
    readingStatus.classList.remove('hidden');
    readingStatus.textContent = state.readingDone ? '🔔 BUZZ NOW!' : '🔊 Reading…';
  } else {
    readingStatus.classList.add('hidden');
  }

  // Answer is hidden from EVERYONE (host included) until it's time to judge —
  // i.e. once a buzzer is locked in and the host must rule correct/incorrect.
  const answerEl = document.getElementById('modalAnswer');
  if (isHost && hasTopBuzzer) {
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
      const buzzerId = state.buzzers.length > 0 ? state.buzzers[0].id : null;
      const buzzerPlayer = buzzerId ? state.players[buzzerId] : null;
      const maxWager = buzzerPlayer ? Math.max(buzzerPlayer.score, q.dollarValue) : q.dollarValue;
      wagerSection.innerHTML = `
        <span>Wager (max $${maxWager}):</span>
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
    const time = new Date(b.clientTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const ms = b.clientTimestamp % 1000;
    buzzersEl.innerHTML = `
      <div class="buzzer-entry" style="background:${color}">
        <span><span class="place">🥇</span>${escHtml(b.name)}</span>
        <span class="buzz-time">${time}.${String(ms).padStart(3,'0')}</span>
      </div>
    `;
  } else {
    buzzersEl.innerHTML = '';
  }

  // Judging controls (host only, once a buzzer is locked in)
  const hqc = document.getElementById('hostQuestionControls');
  const awardContainer = document.getElementById('playerAwardButtons');
  const buzzBtn = document.getElementById('buzzBtn');
  const topBuzzer = state.buzzers && state.buzzers[0];

  if (isHost && topBuzzer) {
    hqc.classList.remove('hidden');
    const player = state.players[topBuzzer.id];
    const value = (q.isDailyDouble && state.dailyDoubleWager !== null)
      ? state.dailyDoubleWager : q.dollarValue;
    awardContainer.innerHTML = `
      <strong style="width:100%;text-align:center">Judging: ${escHtml(player ? player.name : topBuzzer.name)}</strong>
      <button class="award-btn award-correct" onclick="awardPoints('${topBuzzer.id}', true)">✓ Correct (+$${value})</button>
      <button class="award-btn award-wrong" onclick="awardPoints('${topBuzzer.id}', false)">✗ Wrong (-$${value})</button>
    `;
  } else {
    hqc.classList.add('hidden');
    awardContainer.innerHTML = '';
  }

  // Everyone (host included) can buzz until someone is locked in
  if (topBuzzer) {
    buzzBtn.classList.add('hidden');
  } else {
    updateBuzzButton();
  }
}

function renderGameOver() {
  const players = Object.values(state.players || {}).sort((a,b) => b.score - a.score);
  const maxScore = players[0]?.score;
  document.getElementById('finalScores').innerHTML = players.map((p, i) => `
    <div class="final-score-row" style="background:${p.color}">
      <span>${i+1}. ${escHtml(p.name)}</span>
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
  socket.emit('setCategories', { singleCategories: single, doubleCategories: double });
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
  if (buzzState !== 'ready') return;
  if (!state || !state.currentQuestion || !state.buzzOpen) return;
  const btn = document.getElementById('buzzBtn');
  if (btn) btn.disabled = true; // prevent double-tap; server result sets final state
  socket.emit('buzz', { clientTimestamp: Date.now() });
}

// ── Utils ─────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return String(str).replace(/'/g,"\\'");
}
