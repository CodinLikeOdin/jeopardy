const socket = io();
let myId = null;
let isHost = false;
let state = null;
let hasBuzzed = false;
let lastSpokenQuestion = null;

function speakClue(text) {
  if (!window.speechSynthesis) {
    if (isHost) socket.emit('openBuzzers');
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.9;
  utter.pitch = 1;
  if (isHost) {
    let opened = false;
    function openOnce() {
      if (!opened) { opened = true; socket.emit('openBuzzers'); }
    }
    utter.onend = openOnce;
    // Fallback: some browsers never fire onend on repeated utterances
    const fallbackMs = Math.ceil(text.length / 12) * 1000 + 2500;
    setTimeout(openOnce, fallbackMs);
  }
  window.speechSynthesis.speak(utter);
}

// ── Connection ──────────────────────────────────────────────
function joinAsPlayer() {
  const name = document.getElementById('playerName').value.trim();
  if (!name) return alert('Enter your name first');
  isHost = false;
  socket.emit('join', { name, isHost: false });
}

function joinAsHost() {
  const name = document.getElementById('playerName').value.trim() || 'Host';
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

socket.on('buzzersOpen', () => {
  hasBuzzed = false;
  const btn = document.getElementById('buzzBtn');
  if (btn) {
    btn.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'BUZZ IN';
  }
});

socket.on('error', ({ message }) => {
  alert('Error: ' + message);
});

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

  // Auto-read clue aloud on host when question first appears
  const questionKey = `${q.round}|${q.category}|${q.valueIndex}`;
  if (isHost && questionKey !== lastSpokenQuestion) {
    lastSpokenQuestion = questionKey;
    speakClue(q.clue);
  }

  // Answer (host can always see it)
  const answerEl = document.getElementById('modalAnswer');
  if (isHost) {
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

  // Host controls
  const hqc = document.getElementById('hostQuestionControls');
  const pbs = document.getElementById('playerBuzzSection');
  const buzzBtn = document.getElementById('buzzBtn');

  if (isHost) {
    hqc.classList.remove('hidden');
    pbs.classList.add('hidden');

    // Award buttons for top buzzer
    const awardContainer = document.getElementById('playerAwardButtons');
    const topBuzzer = state.buzzers && state.buzzers[0];
    if (topBuzzer) {
      const player = state.players[topBuzzer.id];
      const value = (q.isDailyDouble && state.dailyDoubleWager !== null)
        ? state.dailyDoubleWager : q.dollarValue;
      awardContainer.innerHTML = `
        <strong style="width:100%;text-align:center">Judging: ${escHtml(player ? player.name : topBuzzer.name)}</strong>
        <button class="award-btn award-correct" onclick="awardPoints('${topBuzzer.id}', true)">✓ Correct (+$${value})</button>
        <button class="award-btn award-wrong" onclick="awardPoints('${topBuzzer.id}', false)">✗ Wrong (-$${value})</button>
      `;
    } else {
      awardContainer.innerHTML = '';
    }
  } else {
    hqc.classList.add('hidden');
    pbs.classList.remove('hidden');
    if (state.buzzOpen && !hasBuzzed) {
      buzzBtn.classList.remove('hidden');
      buzzBtn.disabled = false;
    } else if (!state.buzzOpen) {
      buzzBtn.classList.add('hidden');
    }
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

function openBuzzers() {
  socket.emit('openBuzzers');
}

function closeBuzzers() {
  socket.emit('closeBuzzers');
}

function skipQuestion() {
  socket.emit('skipQuestion');
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
  if (hasBuzzed) return;
  hasBuzzed = true;
  const btn = document.getElementById('buzzBtn');
  btn.disabled = true;
  btn.textContent = 'BUZZED!';
  socket.emit('buzz', { clientTimestamp: Date.now() });
}

// ── Utils ─────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return String(str).replace(/'/g,"\\'");
}
