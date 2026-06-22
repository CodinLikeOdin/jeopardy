require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/categories', (req, res) => {
  res.sendFile(path.join(__dirname, 'categories.json'));
});

// Generate clue audio via ElevenLabs (128kbps CBR mp3). Returns a Buffer or null.
async function generateTTS(text) {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  try {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'VR6AewLTigWG4xSOukaG'; // Arnold (announcer)
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!response.ok) {
      console.error('ElevenLabs error:', await response.text());
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.error('TTS error:', err);
    return null;
  }
}

// The current question's audio, cached so every device fetches the same bytes
// with a single ElevenLabs call. Keyed by an id that changes per question.
let currentAudio = null; // { id, buffer }

app.get('/api/tts/current', (req, res) => {
  if (!currentAudio) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(currentAudio.buffer);
});

// Legacy direct TTS (still used as a fallback by the client if needed)
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'no text' });
  const buffer = await generateTTS(text);
  if (!buffer) return res.status(503).json({ error: 'tts unavailable' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(buffer);
});

const client = new Anthropic();

const LEAD_IN_MS = 2500;       // time for clients to fetch+decode audio before it starts
const FIRST_TIMEOUT_MS = 8000; // first buzz window after the clue finishes
const RETRY_TIMEOUT_MS = 3000; // buzz window after a wrong answer
const REARM_MS = 1000;         // synced "get ready" before buzzers re-arm on retry
const SETTLE_MS = 250;         // collect near-simultaneous buzzes, then pick earliest
const LOCKOUT_MS = 250;        // early/mash penalty

let gameState = {
  phase: 'lobby',
  players: {},
  categories: [],
  board: { single: null, double: null },
  currentQuestion: null,   // also carries: audioStartTime, buzzArmTime, bannedPlayers, revealed
  buzzers: [],             // [{ id, name, ts }] — the locked-in winner (length 1) when chosen
  buzzOpen: false,
  audioStartTime: null,    // server-clock ms when audio should start on all devices
  buzzArmTime: null,       // server-clock ms when buzzers go live (audio end / re-arm)
  dailyDoubles: [],
  dailyDoubleWager: null,
  hostId: null,
  boardControl: null,
  usedSquares: { single: {}, double: {} },
};

// Per-question transient state (lockUntil is broadcast; the rest is server-only)
let lockUntil = {};        // playerId -> server-clock ts they may buzz again
let pendingBuzzes = [];     // valid buzzes collected during the settle window
let buzzSettleHandle = null;
let questionTimeoutHandle = null;
let revealTimeoutHandle = null;

function clearQuestionTimeout() {
  if (questionTimeoutHandle) { clearTimeout(questionTimeoutHandle); questionTimeoutHandle = null; }
  if (revealTimeoutHandle) { clearTimeout(revealTimeoutHandle); revealTimeoutHandle = null; }
  if (buzzSettleHandle) { clearTimeout(buzzSettleHandle); buzzSettleHandle = null; }
}

// Schedule the "nobody buzzed" timeout to fire `windowMs` after buzzers arm.
function scheduleNoBuzzTimeout(windowMs) {
  if (questionTimeoutHandle) { clearTimeout(questionTimeoutHandle); questionTimeoutHandle = null; }
  const fireIn = Math.max(0, gameState.buzzArmTime - Date.now()) + windowMs;
  questionTimeoutHandle = setTimeout(() => {
    questionTimeoutHandle = null;
    if (gameState.currentQuestion && gameState.buzzers.length === 0 && pendingBuzzes.length === 0) {
      io.emit('questionTimeout');         // clients play the "nobody got it" buzzers
      revealAnswerThenClear();
    }
  }, fireIn);
}

// A valid buzz arrived: after a short settle, the earliest synced timestamp wins.
function finalizeBuzz() {
  buzzSettleHandle = null;
  if (!gameState.currentQuestion || pendingBuzzes.length === 0) return;
  pendingBuzzes.sort((a, b) => a.ts - b.ts);
  gameState.buzzers = [pendingBuzzes[0]];
  gameState.buzzOpen = false;
  pendingBuzzes = [];
  broadcastState();
}

// Reopen buzzing for everyone not banned, re-armed at a synced moment.
function reopenBuzzers(windowMs) {
  lockUntil = {};
  pendingBuzzes = [];
  gameState.buzzers = [];
  gameState.buzzOpen = true;
  gameState.buzzArmTime = Date.now() + REARM_MS;
  scheduleNoBuzzTimeout(windowMs);
  broadcastState();
}

// Show the answer to EVERYONE for 5 seconds, then clear the board.
function revealAnswerThenClear() {
  clearQuestionTimeout();
  if (!gameState.currentQuestion) return;
  gameState.buzzOpen = false;
  gameState.currentQuestion.revealed = true;
  broadcastState();
  revealTimeoutHandle = setTimeout(() => {
    revealTimeoutHandle = null;
    gameState.currentQuestion = null;
    gameState.audioStartTime = null;
    gameState.buzzArmTime = null;
    currentAudio = null;
    broadcastState();
  }, 5000);
}

function resetGame() {
  clearQuestionTimeout();
  lockUntil = {};
  pendingBuzzes = [];
  currentAudio = null;
  gameState = {
    phase: 'lobby',
    players: {},
    categories: [],
    board: { single: null, double: null },
    currentQuestion: null,
    buzzers: [],
    buzzOpen: false,
    audioStartTime: null,
    buzzArmTime: null,
    dailyDoubles: [],
    dailyDoubleWager: null,
    hostId: null,
    boardControl: null,
    usedSquares: { single: {}, double: {} },
  };
}

function broadcastState() {
  // lockUntil (per-player buzz penalty) is transient server state, but the
  // client needs it to render each player's buzz button authoritatively.
  io.emit('state', JSON.parse(JSON.stringify({ ...gameState, lockUntil })));
}

function extractJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  // Walk forward tracking brace depth (ignoring braces inside strings)
  // to find the end of the first complete, balanced object.
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('No balanced JSON object found in response');
}

// Run async tasks with a concurrency cap (avoids hammering the API / rate limits).
async function runWithConcurrency(items, limit, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// Generate one category's 5 clues in a SINGLE self-verifying call (was two calls).
// Retries a couple of times on transient errors / malformed JSON.
async function generateQuestions(category) {
  const prompt = `You are writing one category for a game of Jeopardy!: "${category}".

Write exactly 5 clues, ordered easiest (index 0) to hardest (index 4). In Jeopardy! the host READS a clue (a statement) and players respond with a QUESTION ("What is...?").

ACCURACY IS CRITICAL: state only facts you are highly confident are true. Mentally fact-check each clue and fix anything uncertain before answering. Avoid obscure stats, exact dates, or records you might misremember.

Return ONLY valid JSON, no other text:
{"clues":[{"clue":"...","answer":"What is ...?"},{"clue":"...","answer":"What is ...?"},{"clue":"...","answer":"What is ...?"},{"clue":"...","answer":"What is ...?"},{"clue":"...","answer":"What is ...?"}]}

Rules:
- each clue is a statement/description, NOT a question
- each answer is phrased "What is X?" or "Who is X?"
- concise and unambiguous`;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await client.messages.create(
        { model: 'claude-sonnet-4-6', max_tokens: 900, messages: [{ role: 'user', content: prompt }] },
        { timeout: 45000, maxRetries: 1 }
      );
      const clues = JSON.parse(extractJSON(resp.content[0].text.trim())).clues;
      if (Array.isArray(clues) && clues.length >= 5) return clues.slice(0, 5);
      throw new Error('unexpected clue shape');
    } catch (err) {
      lastErr = err;
      console.error(`generate "${category}" attempt ${attempt + 1} failed:`, err.message);
    }
  }
  throw lastErr;
}

function pickDailyDoubles(board) {
  const cats = Object.keys(board);
  const squares = [];
  for (const cat of cats) {
    for (let i = 1; i < 5; i++) squares.push({ cat, valueIndex: i });
  }
  for (let i = squares.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [squares[i], squares[j]] = [squares[j], squares[i]];
  }
  return squares.slice(0, 2);
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Test-only hook (inert unless TEST_HOOKS=1) to inject a board without the API
  if (process.env.TEST_HOOKS === '1') {
    socket.on('__test_inject', ({ board, phase }) => {
      gameState.board.single = board;
      gameState.board.double = board;
      gameState.dailyDoubles = [];
      gameState.phase = phase || 'single';
      gameState.categories = Object.keys(board);
      broadcastState();
    });
  }

  socket.on('join', ({ name, isHost }) => {
    if (isHost) {
      gameState.hostId = socket.id;
      if (gameState.phase === 'lobby') gameState.phase = 'setup';
    }

    // Reconnect handling: if a player with this name already exists (e.g. their
    // phone dropped and rejoined with a new socket id), reclaim their entry so
    // their accumulated score is preserved instead of resetting to zero.
    const existingId = Object.keys(gameState.players).find(id =>
      id !== socket.id &&
      !!gameState.players[id].isHost === !!isHost &&
      gameState.players[id].name.toLowerCase() === name.trim().toLowerCase()
    );
    if (existingId) {
      gameState.players[socket.id] = { ...gameState.players[existingId], disconnected: false };
      delete gameState.players[existingId];
      if (gameState.boardControl === existingId) gameState.boardControl = socket.id;
    } else {
      const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];
      const usedColors = Object.values(gameState.players).map(p => p.color);
      const color = colors.find(c => !usedColors.includes(c)) || colors[Math.floor(Math.random() * colors.length)];
      gameState.players[socket.id] = { name: name.trim(), score: 0, color, isHost: !!isHost };
    }
    socket.emit('joined', { id: socket.id });
    broadcastState();
  });

  socket.on('setCategories', async ({ singleCategories, doubleCategories }) => {
    if (socket.id !== gameState.hostId) return;
    gameState.phase = 'generating';
    gameState.categories = singleCategories;

    const tasks = [
      ...singleCategories.map(cat => ({ round: 'single', cat })),
      ...doubleCategories.map(cat => ({ round: 'double', cat })),
    ];
    gameState.genProgress = { done: 0, total: tasks.length };
    broadcastState();

    const singleBoard = {}, doubleBoard = {};
    const failures = [];

    // All categories generate concurrently (capped), with live progress.
    await runWithConcurrency(tasks, 6, async (t) => {
      try {
        const clues = await generateQuestions(t.cat);
        (t.round === 'single' ? singleBoard : doubleBoard)[t.cat] = clues;
      } catch (err) {
        failures.push(t.cat);
      }
      gameState.genProgress.done++;
      broadcastState();
    });

    if (failures.length) {
      console.error('Failed categories:', failures.join(', '));
      socket.emit('error', { message: `Could not generate: ${failures.join(', ')}. Please try again.` });
      gameState.phase = 'setup';
      gameState.genProgress = null;
      broadcastState();
      return;
    }

    gameState.board.single = singleBoard;
    gameState.board.double = doubleBoard;
    gameState.dailyDoubles = pickDailyDoubles(doubleBoard);
    gameState.phase = 'single';
    gameState.genProgress = null;
    broadcastState();
  });

  // Clock sync: client measures round-trip and estimates its offset from server time
  socket.on('syncPing', (t0) => {
    socket.emit('syncPong', { t0, serverTime: Date.now() });
  });

  socket.on('selectSquare', async ({ round, category, valueIndex }) => {
    if (socket.id !== gameState.hostId) return;
    const key = `${category}|${valueIndex}`;
    if (gameState.usedSquares[round][key]) return;

    const board = round === 'single' ? gameState.board.single : gameState.board.double;
    const clue = board[category][valueIndex];
    const values = round === 'single' ? [100,200,300,400,500] : [200,400,600,800,1000];
    const dollarValue = values[valueIndex];

    const isDailyDouble = round === 'double' &&
      gameState.dailyDoubles.some(dd => dd.cat === category && dd.valueIndex === valueIndex);

    clearQuestionTimeout();
    lockUntil = {};
    pendingBuzzes = [];
    gameState.usedSquares[round][key] = true;
    gameState.currentQuestion = {
      round, category, valueIndex, dollarValue,
      clue: clue.clue, answer: clue.answer, isDailyDouble,
      bannedPlayers: [],
    };
    gameState.buzzers = [];
    gameState.buzzOpen = false;       // opens at buzzArmTime
    gameState.audioStartTime = null;
    gameState.buzzArmTime = null;
    gameState.dailyDoubleWager = null;
    broadcastState();

    // Generate the clue audio once on the server; every device fetches the same
    // bytes and plays it in sync, so no contestant hears it earlier than another.
    const audioId = `${round}|${category}|${valueIndex}|${Date.now()}`;
    const buffer = await generateTTS(clue.clue);
    // The question may have been cleared/replaced while awaiting TTS
    if (!gameState.currentQuestion || gameState.currentQuestion.clue !== clue.clue) return;

    currentAudio = buffer ? { id: audioId, buffer } : null;
    // Estimate clip duration: 128kbps CBR mp3 ≈ bytes*8/128000 sec, + tail.
    const durationMs = buffer
      ? Math.ceil((buffer.length * 8 / 128000) * 1000) + 600
      : Math.ceil(clue.clue.length / 12 * 1000) + 1500;

    gameState.audioStartTime = Date.now() + LEAD_IN_MS;
    if (!isDailyDouble) {
      gameState.buzzOpen = true;
      gameState.buzzArmTime = gameState.audioStartTime + durationMs;
      scheduleNoBuzzTimeout(FIRST_TIMEOUT_MS);
    }
    broadcastState();
  });

  // ts = the buzzing client's estimate of current SERVER time (synced clock)
  socket.on('buzz', ({ ts }) => {
    const q = gameState.currentQuestion;
    if (!q || q.isDailyDouble || q.revealed || !gameState.buzzOpen) return;
    const player = gameState.players[socket.id];
    if (!player) return;
    if (q.bannedPlayers.includes(socket.id)) return;          // already answered wrong
    if (gameState.buzzers.some(b => b.id === socket.id)) return;
    if (pendingBuzzes.some(b => b.id === socket.id)) return;   // already in this window
    if (typeof ts !== 'number') ts = Date.now();

    const armTime = gameState.buzzArmTime;
    const locked = lockUntil[socket.id] && ts < lockUntil[socket.id];
    // Pressed before buzzers armed, or during a personal lockout → penalize.
    // Every such press RESETS the lockout, so mashing keeps you frozen.
    if (armTime == null || ts < armTime || locked) {
      lockUntil[socket.id] = ts + LOCKOUT_MS;
      broadcastState();
      return;
    }

    // Valid buzz — collect for a short settle window, then earliest ts wins.
    if (questionTimeoutHandle) { clearTimeout(questionTimeoutHandle); questionTimeoutHandle = null; }
    pendingBuzzes.push({ id: socket.id, name: player.name, ts });
    if (!buzzSettleHandle) buzzSettleHandle = setTimeout(finalizeBuzz, SETTLE_MS);
  });

  socket.on('awardPoints', ({ playerId, correct }) => {
    if (socket.id !== gameState.hostId) return;
    const q = gameState.currentQuestion;
    if (!q) return;
    const value = q.isDailyDouble && gameState.dailyDoubleWager !== null
      ? gameState.dailyDoubleWager : q.dollarValue;
    if (gameState.players[playerId]) {
      gameState.players[playerId].score += correct ? value : -value;
    }

    if (correct) {
      gameState.boardControl = playerId;
      revealAnswerThenClear();            // show answer to everyone, then clear
      return;
    }

    // WRONG: that player is out for this question; reopen for the rest.
    if (!q.bannedPlayers.includes(playerId)) q.bannedPlayers.push(playerId);
    gameState.buzzers = [];

    // Daily doubles have a single player — a wrong answer ends the clue.
    if (q.isDailyDouble) { revealAnswerThenClear(); return; }

    const contestants = Object.keys(gameState.players);
    const remaining = contestants.filter(id => !q.bannedPlayers.includes(id));
    if (remaining.length === 0) {
      revealAnswerThenClear();            // nobody left to try
    } else {
      reopenBuzzers(RETRY_TIMEOUT_MS);    // 3s for the others
    }
    broadcastState();
  });

  socket.on('dailyDoubleWager', ({ wager }) => {
    if (socket.id !== gameState.hostId) return;
    gameState.dailyDoubleWager = wager;
    broadcastState();
  });

  socket.on('advanceRound', () => {
    if (socket.id !== gameState.hostId) return;
    clearQuestionTimeout();
    if (gameState.phase === 'single') {
      gameState.phase = 'double';
      gameState.currentQuestion = null;
      gameState.buzzers = [];
      gameState.buzzOpen = false;
    } else if (gameState.phase === 'double') {
      gameState.phase = 'gameover';
    }
    broadcastState();
  });

  socket.on('resetGame', () => {
    if (socket.id !== gameState.hostId) return;
    resetGame();
    broadcastState();
  });

  socket.on('disconnect', () => {
    if (gameState.players[socket.id]) {
      gameState.players[socket.id].disconnected = true;
      broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jeopardy server running on http://localhost:${PORT}`));
