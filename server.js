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

const client = new Anthropic();

// Game state
let gameState = {
  phase: 'lobby', // lobby, setup, generating, single, double, gameover
  players: {},    // id -> { name, score, color }
  categories: [], // array of category names
  board: {
    single: null,
    double: null,
  },
  currentQuestion: null,
  buzzers: [],           // [{ id, name, clientTimestamp, serverTimestamp }]
  buzzOpen: false,
  dailyDoubles: [],
  dailyDoubleWager: null,
  hostId: null,
  boardControl: null,    // playerId who has control of the board
  usedSquares: { single: {}, double: {} },
};

function resetGame() {
  gameState = {
    phase: 'lobby',
    players: {},
    categories: [],
    board: { single: null, double: null },
    currentQuestion: null,
    buzzers: [],
    buzzOpen: false,
    dailyDoubles: [],
    dailyDoubleWager: null,
    hostId: null,
    boardControl: null,
    usedSquares: { single: {}, double: {} },
  };
}

function broadcastState() {
  io.emit('state', sanitizeState());
}

function sanitizeState() {
  // Don't send answer to players during active question
  const s = JSON.parse(JSON.stringify(gameState));
  if (s.currentQuestion && s.phase !== 'reveal') {
    // answer is hidden until host reveals
  }
  return s;
}

async function generateQuestions(category) {
  const prompt = `You are writing questions for a Jeopardy! game about the category: "${category}".

Generate exactly 5 Jeopardy!-style clues for this category, ordered from easiest to hardest.
In Jeopardy!, the HOST reads a clue (a statement or description) and contestants respond with a QUESTION (e.g., "What is...?").

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
- Make sure answers are unambiguous`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const json = JSON.parse(text);
  return json.clues;
}

function pickDailyDoubles(board) {
  // Pick 2 random squares in double jeopardy, not in row 0 (200)
  const cats = Object.keys(board);
  const squares = [];
  for (const cat of cats) {
    for (let i = 1; i < 5; i++) { // skip index 0 (easiest/cheapest)
      squares.push({ cat, valueIndex: i });
    }
  }
  // shuffle and pick 2
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
      gameState.phase = 'setup';
    }
    const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];
    const usedColors = Object.values(gameState.players).map(p => p.color);
    const color = colors.find(c => !usedColors.includes(c)) || colors[Math.floor(Math.random() * colors.length)];
    gameState.players[socket.id] = { name, score: 0, color, isHost: !!isHost };
    socket.emit('joined', { id: socket.id });
    broadcastState();
  });

  socket.on('setCategories', async ({ categories }) => {
    if (socket.id !== gameState.hostId) return;
    gameState.phase = 'generating';
    gameState.categories = categories;
    broadcastState();

    try {
      const singleBoard = {};
      const doubleBoard = {};

      for (const cat of categories) {
        const clues1 = await generateQuestions(cat);
        const clues2 = await generateQuestions(cat + ' (advanced)');
        singleBoard[cat] = clues1;
        doubleBoard[cat] = clues2;
      }

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
    const singleValues = [100, 200, 300, 400, 500];
    const doubleValues = [200, 400, 600, 800, 1000];
    const values = round === 'single' ? singleValues : doubleValues;
    const dollarValue = values[valueIndex];

    const isDailyDouble = round === 'double' &&
      gameState.dailyDoubles.some(dd => dd.cat === category && dd.valueIndex === valueIndex);

    gameState.currentQuestion = {
      round,
      category,
      valueIndex,
      dollarValue,
      clue: clue.clue,
      answer: clue.answer,
      isDailyDouble,
      selectedBy: null,
    };
    gameState.buzzers = [];
    gameState.buzzOpen = false;
    gameState.dailyDoubleWager = null;
    gameState.usedSquares[round][key] = true;
    broadcastState();
  });

  socket.on('openBuzzers', () => {
    if (socket.id !== gameState.hostId) return;
    gameState.buzzOpen = true;
    gameState.buzzers = [];
    io.emit('buzzersOpen');
    broadcastState();
  });

  socket.on('buzz', ({ clientTimestamp }) => {
    if (!gameState.buzzOpen) return;
    const alreadyBuzzed = gameState.buzzers.find(b => b.id === socket.id);
    if (alreadyBuzzed) return;
    const player = gameState.players[socket.id];
    if (!player) return;
    gameState.buzzers.push({
      id: socket.id,
      name: player.name,
      clientTimestamp,
      serverTimestamp: Date.now(),
    });
    gameState.buzzers.sort((a, b) => a.clientTimestamp - b.clientTimestamp);
    broadcastState();
  });

  socket.on('closeBuzzers', () => {
    if (socket.id !== gameState.hostId) return;
    gameState.buzzOpen = false;
    broadcastState();
  });

  socket.on('awardPoints', ({ playerId, correct }) => {
    if (socket.id !== gameState.hostId) return;
    const q = gameState.currentQuestion;
    if (!q) return;
    const value = q.isDailyDouble && gameState.dailyDoubleWager !== null
      ? gameState.dailyDoubleWager
      : q.dollarValue;
    if (gameState.players[playerId]) {
      gameState.players[playerId].score += correct ? value : -value;
    }
    if (correct) {
      gameState.boardControl = playerId;
    }
    // Either way: question ends after the first buzzer is judged
    gameState.currentQuestion = null;
    gameState.buzzOpen = false;
    gameState.buzzers = [];
    broadcastState();
  });

  socket.on('skipQuestion', () => {
    if (socket.id !== gameState.hostId) return;
    gameState.currentQuestion = null;
    gameState.buzzOpen = false;
    gameState.buzzers = [];
    broadcastState();
  });

  socket.on('dailyDoubleWager', ({ wager }) => {
    if (socket.id !== gameState.hostId) return;
    gameState.dailyDoubleWager = wager;
    broadcastState();
  });

  socket.on('advanceRound', () => {
    if (socket.id !== gameState.hostId) return;
    if (gameState.phase === 'single') {
      gameState.phase = 'double';
      gameState.currentQuestion = null;
      gameState.buzzers = [];
      gameState.buzzOpen = false;
      // boardControl carries over into double jeopardy
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
