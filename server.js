require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const CATEGORIES_PATH = path.join(__dirname, 'categories.json');

// ── Persistent topic pool ────────────────────────────────────
// The default single/double categories live in categories.json (in the repo).
// The mutable random-selection POOL is stored in a GitHub Gist when configured
// (GIST_TOKEN + GIST_ID), so topics added by the host survive restarts and
// redeploys on Render's ephemeral filesystem. Without those env vars it falls
// back to reading/writing categories.json locally.
const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID = process.env.GIST_ID;
const GIST_FILENAME = 'jeopardy-pool.json';
const useGist = !!(GIST_TOKEN && GIST_ID);

function localPool() {
  try { return JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8')).pool || []; }
  catch (e) { return []; }
}

async function readPool() {
  if (useGist) {
    try {
      const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { Authorization: `Bearer ${GIST_TOKEN}`, Accept: 'application/vnd.github+json' },
      });
      if (r.ok) {
        const g = await r.json();
        const f = g.files && g.files[GIST_FILENAME];
        if (f && f.content) return JSON.parse(f.content);
      } else {
        console.error('Gist read failed:', r.status);
      }
    } catch (e) {
      console.error('Gist read error:', e.message);
    }
  }
  return localPool();
}

async function writePool(pool) {
  if (useGist) {
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${GIST_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(pool, null, 2) } } }),
    });
    if (!r.ok) throw new Error('gist write failed: ' + r.status);
    return;
  }
  // Local fallback
  let data = {};
  try { data = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8')); } catch (e) {}
  data.pool = pool;
  fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(data, null, 2) + '\n');
}

app.get('/api/categories', async (req, res) => {
  let data = { single: [], double: [], pool: [] };
  try { data = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8')); } catch (e) {}
  data.pool = await readPool();
  res.json(data);
});

// Add or remove a topic from the persistent random-selection pool.
// body: { action: 'add' | 'remove', topic: '...' }
app.post('/api/categories/pool', async (req, res) => {
  const { action, topic } = req.body || {};
  const t = (topic || '').trim();
  if (!t) return res.status(400).json({ error: 'no topic' });

  let pool = await readPool();
  if (action === 'add') {
    if (!pool.some(c => c.toLowerCase() === t.toLowerCase())) pool.push(t);
    pool.sort((a, b) => a.localeCompare(b));
  } else if (action === 'remove') {
    pool = pool.filter(c => c.toLowerCase() !== t.toLowerCase());
  } else {
    return res.status(400).json({ error: 'bad action' });
  }

  try {
    await writePool(pool);
  } catch (e) {
    return res.status(500).json({ error: 'could not save: ' + e.message });
  }
  res.json({ pool });
});

let lastTtsError = 'none yet';   // surfaced via /api/tts/diag for debugging

// Generate clue audio via ElevenLabs (128kbps CBR mp3). Returns a Buffer or null.
// Hard-capped with an AbortController so a slow/hung request can NEVER freeze
// the game — on timeout we just proceed with the on-screen text + visual cue.
async function generateTTS(text) {
  if (!process.env.ELEVENLABS_API_KEY) { lastTtsError = 'ELEVENLABS_API_KEY not set on server'; return null; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'VR6AewLTigWG4xSOukaG'; // Arnold (announcer)
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY.trim(),
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
      const body = await response.text();
      lastTtsError = `HTTP ${response.status}: ${body.slice(0, 300)}`;
      console.error('ElevenLabs error:', lastTtsError);
      return null;
    }
    lastTtsError = 'ok';
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    lastTtsError = (err && err.name === 'AbortError' ? 'timed out after 12s' : 'fetch threw: ' + (err && err.message ? err.message : String(err)));
    console.error('TTS error:', lastTtsError);
    return null;
  } finally {
    clearTimeout(timer);
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

// Contestant photos (small JPEG thumbnails) kept in memory, served by player id.
// Stored separately from game state so frequent state broadcasts stay tiny.
let photos = {}; // playerId -> Buffer

app.get('/api/photo/:id', (req, res) => {
  const buf = photos[req.params.id];
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(buf);
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
const DEFAULT_BUZZ_MS = 8000;  // default first buzz window after the clue finishes
const RETRY_TIMEOUT_MS = 3000; // buzz window after a wrong answer
const REARM_MS = 1000;         // synced "get ready" before buzzers re-arm on retry
const SETTLE_MS = 250;         // collect near-simultaneous buzzes, then pick earliest
const LOCKOUT_MS = 250;        // early/mash penalty
const DD_TIMEOUT_MS = 20000;   // daily double answer window
const DEFAULT_FINAL_MS = 30000; // default Final Jeopardy answer window
const FINAL_PAUSE_MS = 1000;    // beat between the final clue ending and the timer/music

function defaultSettings() {
  return { enforceEarlyPenalty: true, buzzTimeoutMs: DEFAULT_BUZZ_MS, finalAnswerMs: DEFAULT_FINAL_MS };
}

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
  settings: defaultSettings(),
  usedSquares: { single: {}, double: {} },
  finalCategory: null,       // host-chosen Final Jeopardy category ('' => AI picks)
  finalJeopardy: null,       // { category, clue, answer } — reviewed/edited before the game
  finalRegenerating: false,  // true while the host's regenerate request is in flight
  final: null,               // live Final Jeopardy play-state (see startFinalRound)
};

// Per-question transient state (lockUntil is broadcast; the rest is server-only)
let lockUntil = {};        // playerId -> server-clock ts they may buzz again
let pendingBuzzes = [];     // valid buzzes collected during the settle window
let buzzSettleHandle = null;
let questionTimeoutHandle = null;
let revealTimeoutHandle = null;
let finalTimeoutHandle = null;  // Final Jeopardy answer-window close

function clearQuestionTimeout() {
  if (questionTimeoutHandle) { clearTimeout(questionTimeoutHandle); questionTimeoutHandle = null; }
  if (revealTimeoutHandle) { clearTimeout(revealTimeoutHandle); revealTimeoutHandle = null; }
  if (buzzSettleHandle) { clearTimeout(buzzSettleHandle); buzzSettleHandle = null; }
}

function clearFinalTimeout() {
  if (finalTimeoutHandle) { clearTimeout(finalTimeoutHandle); finalTimeoutHandle = null; }
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

// Daily double answer window: when time runs out, just play the buzzer. The
// clue stays up and the host marks it correct/incorrect with no time limit.
function scheduleDailyDoubleTimeout(deadline) {
  if (questionTimeoutHandle) { clearTimeout(questionTimeoutHandle); questionTimeoutHandle = null; }
  questionTimeoutHandle = setTimeout(() => {
    questionTimeoutHandle = null;
    if (gameState.currentQuestion && gameState.currentQuestion.isDailyDouble && !gameState.currentQuestion.revealed) {
      io.emit('questionTimeout');   // play the buzzer; host still judges, untimed
    }
  }, Math.max(0, deadline - Date.now()));
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

// Generate + arm the spoken clue for the current question. Returns the
// server-clock time the clue finishes (clueEnd), or null if the question
// changed while awaiting TTS. Sets audioStartTime so clients reveal/play it.
async function readCurrentClue(q) {
  const buffer = await generateTTS(q.clue);
  if (gameState.currentQuestion !== q) return null;   // replaced/cleared while awaiting
  currentAudio = buffer ? { id: 'a' + Date.now(), buffer } : null;
  const durationMs = buffer
    ? Math.ceil((buffer.length * 8 / 128000) * 1000) + 600
    : Math.ceil(q.clue.length / 12 * 1000) + 1500;
  gameState.audioStartTime = Date.now() + LEAD_IN_MS;
  return gameState.audioStartTime + durationMs;
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
  }, 2500);
}

function resetGame() {
  clearQuestionTimeout();
  clearFinalTimeout();
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
    settings: defaultSettings(),
    usedSquares: { single: {}, double: {} },
    finalCategory: null,
    finalJeopardy: null,
    finalRegenerating: false,
    final: null,
  };
}

function broadcastState() {
  // lockUntil (per-player buzz penalty) is transient server state, but the
  // client needs it to render each player's buzz button authoritatively.
  io.emit('state', JSON.parse(JSON.stringify({ ...gameState, lockUntil })));
}

// Initialize Final Jeopardy when advancing past Double Jeopardy. Eligible =
// players with a positive score (classic rule); if nobody qualifies, everyone
// plays so the round isn't empty.
function startFinalRound() {
  clearQuestionTimeout();
  clearFinalTimeout();
  currentAudio = null;
  const fj = gameState.finalJeopardy;
  if (!fj) { gameState.phase = 'gameover'; broadcastState(); return; }
  const entries = Object.entries(gameState.players).filter(([id, p]) => !p.isHost);
  let eligible = entries.filter(([id, p]) => p.score > 0).map(([id]) => id);
  if (eligible.length === 0) eligible = entries.map(([id]) => id);
  gameState.currentQuestion = null;
  gameState.buzzers = [];
  gameState.buzzOpen = false;
  gameState.audioStartTime = null;
  gameState.buzzArmTime = null;
  gameState.final = {
    category: fj.category,
    clue: fj.clue,
    answer: fj.answer,
    stage: 'wager',            // 'wager' -> 'answer' -> 'reveal'
    eligible,
    wagers: {},                // id -> number (secret until revealed)
    answers: {},               // id -> string (secret until revealed)
    answered: {},              // id -> true once entered (drives host progress)
    answerClosed: false,
    audioStartTime: null,      // synced clue-audio start
    jingleStart: null,         // synced think-music start (= clue end)
    jingleDurationMs: null,
    answerDeadline: null,      // server-clock ms the answer input locks
    reveal: {},                // id -> { wager, answer, judged }
    revealOrder: [],           // eligible ids, fixed lowest->highest at reveal start
    winnerId: null,
    crowned: false,
  };
  eligible.forEach(id => { gameState.final.reveal[id] = { wager: false, answer: false, judged: null }; });
  gameState.phase = 'final';
  broadcastState();
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

// Normalize text for comparison: lowercase, drop ALL punctuation, collapse
// whitespace. So "Sgt. Pepper's" and "sgt peppers" compare equal.
function normalizeText(s) {
  return String(s).toLowerCase()
    .replace(/['’`]/g, '')           // drop apostrophes so "pepper's" === "peppers"
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip a Jeopardy answer down to its core ("What is the Eiffel Tower?" -> "eiffel tower").
function answerCore(answer) {
  const stripped = String(answer)
    .replace(/^\s*(what|who|where|when|why|how)\s+(is|are|was|were)\s+/i, '')
    .replace(/^\s*(the|a|an)\s+/i, '');
  return normalizeText(stripped);
}

// A clue "leaks" if its own answer (or the category name) appears in the clue,
// e.g. category "Harry Potter" with answer "Harry Potter". Compared on the
// normalized (punctuation-free) text; very short cores are ignored.
function clueLeaks(clue, answer, category) {
  const core = answerCore(answer);
  if (core.length < 4) return false;
  const hay = normalizeText(clue) + ' ' + normalizeText(category);
  return hay.includes(core);
}

// Generate one category's 5 clues in a SINGLE self-verifying call (was two calls).
// Retries on transient errors, malformed JSON, or answers that leak into the clue.
async function generateQuestions(category) {
  const prompt = `You are writing one category for a game of Jeopardy!: "${category}".

Write exactly 5 clues, ordered easiest (index 0) to hardest (index 4). In Jeopardy! the host READS a clue (a statement) and players respond with a QUESTION ("What is...?").

ACCURACY IS CRITICAL: state only facts you are highly confident are true. Mentally fact-check each clue and fix anything uncertain before answering. Avoid obscure stats, exact dates, or records you might misremember.

NEVER GIVE AWAY THE ANSWER: the answer must NOT appear anywhere in its own clue, and a clue must not simply restate the category. For example, in a "Harry Potter" category, do NOT write "This character from the Harry Potter series..." with the answer "Harry Potter". Describe the subject without naming it.

Return ONLY valid JSON, no other text:
{"clues":[{"clue":"...","answer":"What is ...?"},{"clue":"...","answer":"What is ...?"},{"clue":"...","answer":"What is ...?"},{"clue":"...","answer":"What is ...?"},{"clue":"...","answer":"What is ...?"}]}

Rules:
- each clue is a statement/description, NOT a question
- each answer is phrased "What is X?" or "Who is X?"
- the answer (and the category name) must never appear in the clue text
- concise and unambiguous`;

  let lastErr, best = null, bestLeaks = Infinity;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await client.messages.create(
        { model: 'claude-sonnet-4-6', max_tokens: 900, messages: [{ role: 'user', content: prompt }] },
        { timeout: 45000, maxRetries: 1 }
      );
      const clues = JSON.parse(extractJSON(resp.content[0].text.trim())).clues;
      if (!Array.isArray(clues) || clues.length < 5) throw new Error('unexpected clue shape');
      const five = clues.slice(0, 5);
      const leaks = five.filter(c => clueLeaks(c.clue, c.answer, category)).length;
      if (leaks < bestLeaks) { best = five; bestLeaks = leaks; }   // keep the cleanest so far
      if (leaks === 0) return five;
      throw new Error(`answer leaked into ${leaks} clue(s)`);
    } catch (err) {
      lastErr = err;
      console.error(`generate "${category}" attempt ${attempt + 1} failed:`, err.message);
    }
  }
  // Out of retries: return the cleanest attempt we got, else fail the category.
  if (best) return best;
  throw lastErr;
}

// Generate ONE Final Jeopardy clue — harder and more nuanced than a board clue.
// If `category` is blank, the model also chooses a fitting, broadly-known category.
// Returns { category, clue, answer }. Same self-verifying / leak-check retries.
async function generateFinalClue(category) {
  const want = (category || '').trim();
  const catLine = want
    ? `The category is: "${want}".`
    : `First choose a single, interesting Final Jeopardy category (broadly known, not obscure), then write the clue for it.`;
  const prompt = `You are writing the FINAL JEOPARDY! clue — the hardest, climactic clue of the game.

${catLine}

Write ONE challenging but fair clue. In Jeopardy! the host READS a clue (a statement) and players respond with a QUESTION ("What is...?"). A Final Jeopardy clue is harder than a normal board clue: it rewards real knowledge, but a well-read player should still have a chance.

ACCURACY IS CRITICAL: state only facts you are highly confident are true. Mentally fact-check the clue and fix anything uncertain before answering.

NEVER GIVE AWAY THE ANSWER: the answer (and the category name) must NOT appear anywhere in the clue text.

Return ONLY valid JSON, no other text:
{"category":"...","clue":"...","answer":"What is ...?"}

Rules:
- the clue is a statement/description, NOT a question
- the answer is phrased "What is X?" or "Who is X?"
- the answer (and category name) must never appear in the clue text
- concise and unambiguous`;

  let lastErr, best = null, bestLeaks = Infinity;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await client.messages.create(
        { model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] },
        { timeout: 45000, maxRetries: 1 }
      );
      const obj = JSON.parse(extractJSON(resp.content[0].text.trim()));
      const cat = (want || obj.category || '').trim();
      if (!obj.clue || !obj.answer || !cat) throw new Error('unexpected final clue shape');
      const result = { category: cat, clue: String(obj.clue).trim(), answer: String(obj.answer).trim() };
      const leaks = clueLeaks(result.clue, result.answer, result.category) ? 1 : 0;
      if (leaks < bestLeaks) { best = result; bestLeaks = leaks; }
      if (leaks === 0) return result;
      throw new Error('answer leaked into the final clue');
    } catch (err) {
      lastErr = err;
      console.error(`generate final clue attempt ${attempt + 1} failed:`, err.message);
    }
  }
  if (best) return best;
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
    socket.on('__test_inject', ({ board, phase, settings, dailyDoubles, finalJeopardy }) => {
      gameState.board.single = board;
      gameState.board.double = board;
      gameState.dailyDoubles = dailyDoubles || [];
      gameState.categories = Object.keys(board);
      if (settings) gameState.settings = { ...gameState.settings, ...settings };
      if (finalJeopardy) gameState.finalJeopardy = finalJeopardy;
      const ph = phase || 'single';
      if (ph === 'final') { startFinalRound(); return; }   // builds gameState.final
      gameState.phase = ph;
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
      if (photos[existingId]) { photos[socket.id] = photos[existingId]; delete photos[existingId]; } // carry photo across reconnect
    } else {
      const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];
      const usedColors = Object.values(gameState.players).map(p => p.color);
      const color = colors.find(c => !usedColors.includes(c)) || colors[Math.floor(Math.random() * colors.length)];
      gameState.players[socket.id] = { name: name.trim(), score: 0, color, isHost: !!isHost };
    }
    socket.emit('joined', { id: socket.id });
    broadcastState();
  });

  socket.on('setCategories', async ({ singleCategories, doubleCategories, finalCategory, finalClue: finalClueText, finalAnswer: finalAnswerText, settings }) => {
    if (socket.id !== gameState.hostId) return;
    // Apply per-game settings from the setup screen
    if (settings) {
      gameState.settings = {
        enforceEarlyPenalty: settings.enforceEarlyPenalty !== false,
        buzzTimeoutMs: Math.max(2000, Math.min(60000, Number(settings.buzzTimeoutMs) || DEFAULT_BUZZ_MS)),
        finalAnswerMs: Math.max(5000, Math.min(180000, Number(settings.finalAnswerMs) || DEFAULT_FINAL_MS)),
      };
    }
    gameState.finalCategory = (finalCategory || '').trim();

    // If the host authored their own final question AND answer, use them as-is
    // (no AI call); they can still tweak the wording on the review screen.
    const fClue = (finalClueText || '').trim();
    const fAns = (finalAnswerText || '').trim();
    const manualFinal = (fClue && fAns)
      ? { category: gameState.finalCategory || 'Final Jeopardy', clue: fClue, answer: fAns }
      : null;

    gameState.phase = 'generating';
    gameState.categories = singleCategories;

    const tasks = [
      ...singleCategories.map(cat => ({ round: 'single', cat })),
      ...doubleCategories.map(cat => ({ round: 'double', cat })),
      { round: 'final' },
    ];
    gameState.genProgress = { done: 0, total: tasks.length };
    broadcastState();

    const singleBoard = {}, doubleBoard = {};
    let finalClue = null;
    const failures = [];

    // All categories (plus the Final Jeopardy clue) generate concurrently.
    await runWithConcurrency(tasks, 6, async (t) => {
      try {
        if (t.round === 'final') {
          finalClue = manualFinal ? manualFinal : await generateFinalClue(gameState.finalCategory);
        } else {
          const clues = await generateQuestions(t.cat);
          (t.round === 'single' ? singleBoard : doubleBoard)[t.cat] = clues;
        }
      } catch (err) {
        failures.push(t.round === 'final' ? 'Final Jeopardy' : t.cat);
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
    gameState.finalJeopardy = finalClue;
    // Pause on the review screen so the host can vet/edit/regenerate the final
    // clue before the game starts.
    gameState.phase = 'review';
    gameState.genProgress = null;
    broadcastState();
  });

  // ── Final Jeopardy review (host vets the clue before the game starts) ──
  socket.on('editFinal', ({ category, clue, answer }) => {
    if (socket.id !== gameState.hostId || gameState.phase !== 'review') return;
    if (!gameState.finalJeopardy) return;
    if (typeof category === 'string') gameState.finalJeopardy.category = category.trim();
    if (typeof clue === 'string') gameState.finalJeopardy.clue = clue.trim();
    if (typeof answer === 'string') gameState.finalJeopardy.answer = answer.trim();
    broadcastState();
  });

  socket.on('regenerateFinal', async ({ category } = {}) => {
    if (socket.id !== gameState.hostId || gameState.phase !== 'review') return;
    if (gameState.finalRegenerating) return;
    // If the host typed a new category, regenerate for that; else reuse current.
    const cat = (typeof category === 'string' && category.trim())
      ? category.trim()
      : (gameState.finalJeopardy ? gameState.finalJeopardy.category : '');
    gameState.finalRegenerating = true;
    broadcastState();
    try {
      const fresh = await generateFinalClue(cat);
      if (gameState.phase === 'review') gameState.finalJeopardy = fresh;
    } catch (err) {
      socket.emit('error', { message: 'Could not regenerate the final clue. Try again.' });
    } finally {
      gameState.finalRegenerating = false;
      broadcastState();
    }
  });

  socket.on('beginRounds', () => {
    if (socket.id !== gameState.hostId || gameState.phase !== 'review') return;
    gameState.phase = 'single';
    broadcastState();
  });

  // ── Final Jeopardy play ──────────────────────────────────────
  // Each eligible contestant secretly wagers 0..their score.
  socket.on('submitFinalWager', ({ wager }) => {
    const f = gameState.final;
    if (!f || f.stage !== 'wager' || !f.eligible.includes(socket.id)) return;
    const p = gameState.players[socket.id];
    if (!p) return;
    const max = Math.max(0, p.score);
    let w = Math.round(Number(wager));
    if (!Number.isFinite(w)) w = 0;
    f.wagers[socket.id] = Math.max(0, Math.min(max, w));
    broadcastState();
  });

  // Host reveals the clue and starts the synced think-music + answer timer.
  socket.on('startFinalClue', async () => {
    if (socket.id !== gameState.hostId) return;
    const f = gameState.final;
    if (!f || f.stage !== 'wager') return;
    f.stage = 'answer';
    broadcastState();

    // Read the clue aloud (synced on every device); the jingle + timer then run
    // for finalAnswerMs starting when the clue audio finishes.
    const buffer = await generateTTS(f.clue);
    if (!gameState.final || gameState.final !== f) return;   // round changed while awaiting TTS
    currentAudio = buffer ? { id: 'f' + Date.now(), buffer } : null;
    const durationMs = buffer
      ? Math.ceil((buffer.length * 8 / 128000) * 1000) + 600
      : Math.ceil(f.clue.length / 12 * 1000) + 1500;
    f.audioStartTime = Date.now() + LEAD_IN_MS;
    const clueEnd = f.audioStartTime + durationMs;
    // No buzzer/buzz timer in Final Jeopardy: read the clue, pause a beat, then
    // the answer timer + think-music start together.
    f.jingleStart = clueEnd + FINAL_PAUSE_MS;
    f.jingleDurationMs = gameState.settings.finalAnswerMs;
    f.answerDeadline = f.jingleStart + gameState.settings.finalAnswerMs;
    broadcastState();

    clearFinalTimeout();
    finalTimeoutHandle = setTimeout(() => {
      finalTimeoutHandle = null;
      if (gameState.final === f && f.stage === 'answer' && !f.answerClosed) {
        f.answerClosed = true;
        io.emit('finalTimeUp');
        broadcastState();
      }
    }, Math.max(0, f.answerDeadline - Date.now()));
  });

  // Contestant's answer — stored secretly. Only the FIRST submission broadcasts
  // (to bump the host's "answered" count); later edits update silently.
  socket.on('submitFinalAnswer', ({ answer }) => {
    const f = gameState.final;
    if (!f || f.stage !== 'answer' || f.answerClosed) return;
    if (f.answerDeadline && Date.now() > f.answerDeadline) return;
    if (!f.eligible.includes(socket.id)) return;
    f.answers[socket.id] = String(answer == null ? '' : answer).slice(0, 200);
    if (!f.answered[socket.id]) { f.answered[socket.id] = true; broadcastState(); }
  });

  // Host moves from the (closed) answer stage into one-at-a-time reveal.
  socket.on('beginFinalReveal', () => {
    if (socket.id !== gameState.hostId) return;
    const f = gameState.final;
    if (!f || f.stage !== 'answer') return;
    clearFinalTimeout();
    f.answerClosed = true;
    f.stage = 'reveal';
    // Fix the reveal order now (lowest score first) so applying wagers mid-reveal
    // doesn't reshuffle the list.
    f.revealOrder = [...f.eligible].sort((a, b) =>
      ((gameState.players[a] && gameState.players[a].score) || 0) -
      ((gameState.players[b] && gameState.players[b].score) || 0));
    currentAudio = null;
    broadcastState();
  });

  socket.on('revealFinalAnswer', ({ playerId }) => {
    if (socket.id !== gameState.hostId) return;
    const f = gameState.final;
    if (!f || f.stage !== 'reveal' || !f.reveal[playerId]) return;
    f.reveal[playerId].answer = true;
    broadcastState();
  });

  socket.on('revealFinalWager', ({ playerId }) => {
    if (socket.id !== gameState.hostId) return;
    const f = gameState.final;
    if (!f || f.stage !== 'reveal' || !f.reveal[playerId]) return;
    f.reveal[playerId].wager = true;
    broadcastState();
  });

  // Host rules on a revealed answer; the wager is applied to that player's score.
  socket.on('judgeFinal', ({ playerId, correct }) => {
    if (socket.id !== gameState.hostId) return;
    const f = gameState.final;
    if (!f || f.stage !== 'reveal' || !f.reveal[playerId]) return;
    if (f.reveal[playerId].judged) return;     // already scored — don't double-apply
    const p = gameState.players[playerId];
    const wager = f.wagers[playerId] || 0;
    if (p) p.score += correct ? wager : -wager;
    f.reveal[playerId].judged = correct ? 'correct' : 'wrong';
    f.reveal[playerId].answer = true;          // judging implies both are shown
    f.reveal[playerId].wager = true;
    broadcastState();
  });

  socket.on('crownWinner', () => {
    if (socket.id !== gameState.hostId) return;
    const f = gameState.final;
    if (!f) return;
    const ranked = Object.entries(gameState.players)
      .filter(([id, p]) => !p.isHost)
      .sort((a, b) => b[1].score - a[1].score);
    const winner = ranked[0];
    if (winner) {
      f.winnerId = winner[0];
      f.crowned = true;
      io.emit('finalWinner', { id: winner[0], name: winner[1].name });
    }
    gameState.phase = 'gameover';
    broadcastState();
  });

  // Contestant uploads a small JPEG selfie (data URL). Stored server-side and
  // served via /api/photo/:id; state only carries a flag + version.
  socket.on('setPhoto', ({ dataUrl }) => {
    const p = gameState.players[socket.id];
    if (!p || typeof dataUrl !== 'string') return;
    const m = dataUrl.match(/^data:image\/jpeg;base64,(.+)$/);
    if (!m) return;
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length === 0 || buf.length > 300000) return; // sanity cap ~300KB
    photos[socket.id] = buf;
    p.hasPhoto = true;
    p.photoVersion = (p.photoVersion || 0) + 1;
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

    // Daily double: do NOT read or reveal the clue yet. The contestant places
    // their wager first (untimed); the clue is read from the wager handler.
    if (isDailyDouble) return;

    // Normal question: read the clue now (synced audio on every device).
    const thisQ = gameState.currentQuestion;
    const clueEnd = await readCurrentClue(thisQ);
    if (clueEnd == null) return;       // question changed while awaiting TTS

    gameState.buzzOpen = true;
    // With the early-buzz penalty ON, buzzers arm when the clue FINISHES.
    // With it OFF, they arm when the clue starts appearing (buzz any time, no penalty).
    gameState.buzzArmTime = gameState.settings.enforceEarlyPenalty ? clueEnd : gameState.audioStartTime;
    scheduleNoBuzzTimeout(gameState.settings.buzzTimeoutMs);
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

    // Whether the window is open is judged by the SERVER's own clock (robust to
    // a contestant's clock drift). The client's synced `ts` is used ONLY to
    // order near-simultaneous buzzes fairly.
    const nowSrv = Date.now();
    const orderTs = (typeof ts === 'number') ? ts : nowSrv;
    const armTime = gameState.buzzArmTime;
    const penalty = gameState.settings.enforceEarlyPenalty;
    const early = armTime == null || nowSrv < armTime;

    if (penalty) {
      const locked = lockUntil[socket.id] && nowSrv < lockUntil[socket.id];
      // Pressed before buzzers armed, or during a personal lockout → penalize.
      // Every such press RESETS the lockout, so mashing keeps you frozen.
      if (early || locked) {
        lockUntil[socket.id] = nowSrv + LOCKOUT_MS;
        broadcastState();
        return;
      }
    } else if (early) {
      return; // penalty disabled: buzzing before the window opens is just ignored
    }

    // Valid buzz — collect for a short settle window, then earliest ts wins.
    if (questionTimeoutHandle) { clearTimeout(questionTimeoutHandle); questionTimeoutHandle = null; }
    pendingBuzzes.push({ id: socket.id, name: player.name, ts: orderTs });
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
      const name = gameState.players[playerId] ? gameState.players[playerId].name : '';
      io.emit('correctAnswer', { name, earned: value });   // green flash on all devices
      revealAnswerThenClear();            // show answer to everyone, then clear
      return;
    }

    // WRONG: that player is out for this question; reopen for the rest.
    if (!q.bannedPlayers.includes(playerId)) q.bannedPlayers.push(playerId);
    gameState.buzzers = [];

    // Daily doubles have a single player — a wrong answer ends the clue.
    if (q.isDailyDouble) { revealAnswerThenClear(); return; }

    // Buzzer + big "Incorrect" flash on every device for ~1s, then the others
    // get a chance. The wrong player is banned from re-buzzing this clue.
    const wrongName = gameState.players[playerId] ? gameState.players[playerId].name : '';
    io.emit('wrongAnswer', { name: wrongName, lost: value });
    gameState.buzzOpen = false;           // closed during the 2s "Incorrect" flash
    clearQuestionTimeout();
    broadcastState();

    const remaining = Object.keys(gameState.players).filter(id => !q.bannedPlayers.includes(id));
    questionTimeoutHandle = setTimeout(() => {
      questionTimeoutHandle = null;
      if (!gameState.currentQuestion || gameState.currentQuestion !== q) return;
      if (remaining.length === 0) revealAnswerThenClear();   // nobody left to try
      else reopenBuzzers(RETRY_TIMEOUT_MS);                   // 3s for the others
    }, 2000);
  });

  socket.on('dailyDoubleWager', async ({ wager }) => {
    if (socket.id !== gameState.hostId) return;
    const q = gameState.currentQuestion;
    if (!q || !q.isDailyDouble) return;
    if (gameState.dailyDoubleWager !== null) return;  // wager already locked in
    // The controlling contestant may wager up to their current score, or up to
    // the clue's dollar value if that's higher (even when their score is < $0).
    const ctrl = gameState.boardControl ? gameState.players[gameState.boardControl] : null;
    const maxWager = Math.max(ctrl ? ctrl.score : 0, q.dollarValue);
    let w = Math.round(Number(wager));
    if (!Number.isFinite(w)) w = q.dollarValue;
    gameState.dailyDoubleWager = Math.max(5, Math.min(maxWager, w));
    broadcastState();

    // Now (and only now) read/reveal the clue, then start the answer timer.
    const clueEnd = await readCurrentClue(q);
    if (clueEnd == null) return;
    scheduleDailyDoubleTimeout(clueEnd + DD_TIMEOUT_MS);
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
      startFinalRound();
      return;
    }
    broadcastState();
  });

  socket.on('resetGame', () => {
    if (socket.id !== gameState.hostId) return;
    // Soft reset: keep the host and players (scores zeroed), clear the board,
    // and return to category setup so a new game can start immediately.
    clearQuestionTimeout();
    clearFinalTimeout();
    lockUntil = {};
    pendingBuzzes = [];
    currentAudio = null;
    Object.values(gameState.players).forEach(p => { p.score = 0; });
    gameState.board = { single: null, double: null };
    gameState.currentQuestion = null;
    gameState.buzzers = [];
    gameState.buzzOpen = false;
    gameState.audioStartTime = null;
    gameState.buzzArmTime = null;
    gameState.dailyDoubles = [];
    gameState.dailyDoubleWager = null;
    gameState.boardControl = null;
    gameState.usedSquares = { single: {}, double: {} };
    gameState.categories = [];
    gameState.finalCategory = null;
    gameState.finalJeopardy = null;
    gameState.finalRegenerating = false;
    gameState.final = null;
    gameState.phase = 'setup';
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
