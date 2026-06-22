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

// ElevenLabs TTS proxy
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'no text' });
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'no key' });

  try {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
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
      const err = await response.text();
      console.error('ElevenLabs error:', err);
      return res.status(500).json({ error: err });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: err.message });
  }
});

const client = new Anthropic();

let gameState = {
  phase: 'lobby',
  players: {},
  categories: [],
  board: { single: null, double: null },
  currentQuestion: null,
  buzzers: [],        // [{ id, name, clientTimestamp }] — valid buzzes, sorted
  buzzOpen: false,    // true as soon as question is selected (during reading)
  readingDone: false, // flips when host signals audio finished
  readingDoneTime: null,
  dailyDoubles: [],
  dailyDoubleWager: null,
  hostId: null,
  boardControl: null,
  usedSquares: { single: {}, double: {} },
};

// Per-question transient maps (not part of broadcast state)
let earlyBuzzers = {}; // playerId -> true (buzzed before reading finished)
let lockUntil = {};    // playerId -> timestamp they may buzz again

let questionTimeoutHandle = null;

function clearQuestionTimeout() {
  if (questionTimeoutHandle) {
    clearTimeout(questionTimeoutHandle);
    questionTimeoutHandle = null;
  }
}

// 3 seconds after reading finishes with nobody buzzed in → nobody got it,
// board control is retained, play the "no answer" buzzers.
function startTimeoutIfEmpty() {
  clearQuestionTimeout();
  if (gameState.buzzers.length > 0) return;
  questionTimeoutHandle = setTimeout(() => {
    questionTimeoutHandle = null;
    if (gameState.currentQuestion && gameState.buzzers.length === 0) {
      gameState.currentQuestion = null;
      gameState.buzzOpen = false;
      gameState.readingDone = false;
      gameState.readingDoneTime = null;
      io.emit('questionTimeout');
      broadcastState();
    }
  }, 3000);
}

function resetGame() {
  clearQuestionTimeout();
  gameState = {
    phase: 'lobby',
    players: {},
    categories: [],
    board: { single: null, double: null },
    currentQuestion: null,
    buzzers: [],
    buzzOpen: false,
    readingDone: false,
    readingDoneTime: null,
    dailyDoubles: [],
    dailyDoubleWager: null,
    hostId: null,
    boardControl: null,
    usedSquares: { single: {}, double: {} },
  };
}

function broadcastState() {
  io.emit('state', JSON.parse(JSON.stringify(gameState)));
}

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in response');
  return text.slice(start, end + 1);
}

async function generateQuestions(category) {
  const generatePrompt = `You are writing questions for a Jeopardy! game about the category: "${category}".

Generate exactly 5 Jeopardy!-style clues for this category, ordered from easiest to hardest.
In Jeopardy!, the HOST reads a clue (a statement or description) and contestants respond with a QUESTION (e.g., "What is...?").

CRITICAL: Only include facts you are certain are true. If you are not 100% confident in a specific detail (a date, a school, a statistic, a record), leave that detail out and use a fact you ARE certain about instead.

Return ONLY valid JSON in this exact format, no extra text:
{
  "clues": [
    { "clue": "...", "answer": "What is ...?" },
    { "clue": "...", "answer": "What is ...?" },
    { "clue": "...", "answer": "What is ...?" },
    { "clue": "...", "answer": "What is ...?" },
    { "clue": "...", "answer": "What is ...?" }
  ]
}

Rules:
- Each clue should be a statement/description, NOT a question
- Each answer should be phrased as "What is X?" or "Who is X?"
- Order from simplest (index 0) to most difficult (index 4)
- Keep clues concise and clear
- Make sure answers are unambiguous
- Avoid specific statistics, records, or obscure details that you might misremember`;

  const generateResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: generatePrompt }],
  });

  const generated = JSON.parse(extractJSON(generateResponse.content[0].text.trim()));

  const verifyPrompt = `You are a fact-checker for a Jeopardy! game. Review each clue and answer pair below and check every specific fact stated in the clue.

Clues to verify:
${JSON.stringify(generated.clues, null, 2)}

For each clue, decide:
- KEEP: if all facts in the clue are accurate
- REPLACE: if any fact is wrong or uncertain — replace with a corrected clue about the same subject using only facts you are certain about

Return ONLY valid JSON with exactly 5 clues in this format, no extra text:
{
  "clues": [
    { "clue": "...", "answer": "..." },
    { "clue": "...", "answer": "..." },
    { "clue": "...", "answer": "..." },
    { "clue": "...", "answer": "..." },
    { "clue": "...", "answer": "..." }
  ]
}`;

  const verifyResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: verifyPrompt }],
  });

  return JSON.parse(extractJSON(verifyResponse.content[0].text.trim())).clues;
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

  socket.on('join', ({ name, isHost }) => {
    if (isHost) {
      gameState.hostId = socket.id;
      if (gameState.phase === 'lobby') gameState.phase = 'setup';
    }
    const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];
    const usedColors = Object.values(gameState.players).map(p => p.color);
    const color = colors.find(c => !usedColors.includes(c)) || colors[Math.floor(Math.random() * colors.length)];
    gameState.players[socket.id] = { name, score: 0, color, isHost: !!isHost };
    socket.emit('joined', { id: socket.id });
    broadcastState();
  });

  socket.on('setCategories', async ({ singleCategories, doubleCategories }) => {
    if (socket.id !== gameState.hostId) return;
    gameState.phase = 'generating';
    gameState.categories = singleCategories;
    broadcastState();

    try {
      const singleBoard = {};
      for (const cat of singleCategories) singleBoard[cat] = await generateQuestions(cat);

      const doubleBoard = {};
      for (const cat of doubleCategories) doubleBoard[cat] = await generateQuestions(cat);

      gameState.board.single = singleBoard;
      gameState.board.double = doubleBoard;
      gameState.dailyDoubles = pickDailyDoubles(doubleBoard);
      gameState.phase = 'single';
      broadcastState();
    } catch (err) {
      console.error('Error generating questions:', err);
      socket.emit('error', { message: 'Failed to generate questions: ' + err.message });
      gameState.phase = 'setup';
      broadcastState();
    }
  });

  socket.on('selectSquare', ({ round, category, valueIndex }) => {
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
    earlyBuzzers = {};
    lockUntil = {};
    gameState.currentQuestion = {
      round, category, valueIndex, dollarValue,
      clue: clue.clue, answer: clue.answer, isDailyDouble,
    };
    gameState.buzzers = [];
    gameState.buzzOpen = true;   // open immediately (buzzing during reading is penalized)
    gameState.readingDone = false;
    gameState.readingDoneTime = null;
    gameState.dailyDoubleWager = null;
    gameState.usedSquares[round][key] = true;
    broadcastState();
  });

  // Host signals that audio finished reading
  socket.on('readingFinished', () => {
    if (socket.id !== gameState.hostId) return;
    if (!gameState.currentQuestion || gameState.readingDone) return;

    gameState.readingDone = true;
    gameState.readingDoneTime = Date.now();

    // Anyone who buzzed early is locked out until 250ms after reading completes
    const unlockAt = gameState.readingDoneTime + 250;
    Object.keys(earlyBuzzers).forEach(id => { lockUntil[id] = unlockAt; });
    io.emit('readingDone', { unlockAt, lockedIds: Object.keys(earlyBuzzers) });

    startTimeoutIfEmpty();
    broadcastState();
  });

  socket.on('buzz', ({ clientTimestamp }) => {
    if (!gameState.buzzOpen || !gameState.currentQuestion) return;
    const player = gameState.players[socket.id];
    if (!player) return;
    if (gameState.buzzers.find(b => b.id === socket.id)) return; // already locked in

    // Early buzz (before reading finished) → reject + penalize
    if (!gameState.readingDone) {
      earlyBuzzers[socket.id] = true;
      socket.emit('buzzResult', { status: 'early' });
      return;
    }

    // Still serving a lockout penalty
    if (lockUntil[socket.id] && Date.now() < lockUntil[socket.id]) {
      socket.emit('buzzResult', { status: 'locked', unlockAt: lockUntil[socket.id] });
      return;
    }

    // Valid buzz
    gameState.buzzers.push({ id: socket.id, name: player.name, clientTimestamp });
    gameState.buzzers.sort((a, b) => a.clientTimestamp - b.clientTimestamp);
    clearQuestionTimeout();
    socket.emit('buzzResult', { status: 'accepted' });
    broadcastState();
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
    if (correct) gameState.boardControl = playerId;
    clearQuestionTimeout();
    gameState.currentQuestion = null;
    gameState.buzzOpen = false;
    gameState.buzzers = [];
    gameState.readingDone = false;
    gameState.readingDoneTime = null;
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
