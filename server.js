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

// Host operator URL — serves the same SPA; the client detects the /host path
// and runs in host mode (no host/player choice on the shared player link).
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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

// Optional GitHub REPO (owner/name) for persisting custom-category media
// (images/audio) so they survive redeploys and don't need re-uploading. Uses
// MEDIA_TOKEN, or falls back to GIST_TOKEN if it has `repo` scope.
const MEDIA_REPO = process.env.MEDIA_REPO;
const MEDIA_TOKEN = process.env.MEDIA_TOKEN || GIST_TOKEN;
const useMediaRepo = !!(MEDIA_REPO && MEDIA_TOKEN);
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'weba' };
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', weba: 'audio/webm' };

// GitHub Contents API helpers for the media repo (best-effort; callers catch).
async function ghContents(pathInRepo) {
  const r = await fetch(`https://api.github.com/repos/${MEDIA_REPO}/contents/${pathInRepo}`, {
    headers: { Authorization: `Bearer ${MEDIA_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('gh contents ' + r.status);
  return r.json();
}
async function ghPutFile(pathInRepo, buffer, message) {
  const existing = await ghContents(pathInRepo).catch(() => null);
  const body = { message, content: buffer.toString('base64') };
  if (existing && existing.sha) body.sha = existing.sha;
  const r = await fetch(`https://api.github.com/repos/${MEDIA_REPO}/contents/${pathInRepo}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${MEDIA_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('gh put ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

// Push one custom-media file to media/<catId>/<qIndex>.<ext> in the media repo.
// Returns true if it was durably written, false otherwise.
async function persistMedia(catId, qIndex, contentType, buffer) {
  if (!useMediaRepo) return false;
  const ext = EXT_BY_MIME[contentType] || (contentType.startsWith('image/') ? 'img' : 'bin');
  try { await ghPutFile(`media/${catId}/${qIndex}.${ext}`, buffer, `media ${catId}/${qIndex}`); return true; }
  catch (e) { console.error('media persist failed:', e.message); return false; }
}

// Fetch a persisted media file back from the repo (any extension for that slot).
async function fetchPersistedMedia(catId, qIndex) {
  if (!useMediaRepo) return null;
  try {
    const list = await ghContents(`media/${catId}`);
    if (!Array.isArray(list)) return null;
    const f = list.find(x => x.name && x.name.startsWith(qIndex + '.'));
    if (!f) return null;
    // Pull the raw bytes via the authenticated Contents API (works for private
    // repos; download_url needs a separate short-lived token so we avoid it).
    const rr = await fetch(`https://api.github.com/repos/${MEDIA_REPO}/contents/media/${catId}/${encodeURIComponent(f.name)}`, {
      headers: { Authorization: `Bearer ${MEDIA_TOKEN}`, Accept: 'application/vnd.github.raw' },
    });
    if (!rr.ok) return null;
    const buffer = Buffer.from(await rr.arrayBuffer());
    const ext = f.name.split('.').pop().toLowerCase();
    const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
    return { kind: contentType.startsWith('image/') ? 'image' : 'audio', contentType, buffer };
  } catch (e) { console.error('media fetch failed:', e.message); return null; }
}

// ── Pre-generated question cache ─────────────────────────────────────────────
// To avoid re-querying Anthropic every game, each pooled topic's questions are
// generated ONCE as a "bank" (~20 clues across 5 difficulty tiers) and stored.
// Each game DRAWS 5 (one per tier) from the bank, token-free, so the same topic
// plays differently each time. Banks are sharded across several Gist files
// (hash-bucketed by topic) so the store scales to thousands of topics without
// any single file approaching the Gist API's ~1 MB per-file truncation point.
const QUESTION_SHARDS = 8;
const bankCache = new Map();      // topicKey -> { questions:[{clue,answer,difficulty}], generatedAt }
const loadedShards = new Set();   // shard indices already pulled into bankCache
function topicKey(t) { return String(t || '').trim().toLowerCase(); }
function shardOf(key) { let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; return h % QUESTION_SHARDS; }
function shardFile(i) { return `questions-${i}.json`; }

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

// How many pooled topics already have a cached question bank (for the UI).
app.get('/api/pool/status', async (req, res) => {
  try {
    const pool = await readPool();
    let cached = 0;
    for (const t of pool) if (await getBank(t)) cached++;
    res.json({ total: pool.length, cached });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pre-generate question banks for pooled topics so future games cost no
// Anthropic tokens. By default only fills topics that lack a bank; with
// { force:true } it regenerates EVERY pooled topic (e.g. to upgrade older,
// smaller banks). One-time-ish admin action; can take a while. Returns a summary.
let warming = false;
let warmProgress = { active: false, done: 0, total: 0, force: false };
app.post('/api/pool/warm', async (req, res) => {
  if (warming) return res.status(409).json({ error: 'already pre-generating — please wait' });
  warming = true;
  const force = !!(req.body && req.body.force);
  warmProgress = { active: true, done: 0, total: 0, force };
  try {
    const pool = await readPool();
    const targets = [];
    for (const t of pool) if (force || !(await getBank(t))) targets.push(t);
    warmProgress.total = targets.length;

    const fresh = [], failed = [];
    await runWithConcurrency(targets, 4, async (t) => {
      try {
        const bank = { questions: await generateQuestionBank(t), generatedAt: Date.now() };
        if (drawBoardClues(bank)) fresh.push({ topic: t, bank });
        else failed.push(t);
      } catch (e) { failed.push(t); }
      warmProgress.done++;
    });
    if (fresh.length) await saveBanks(fresh);
    res.json({ total: pool.length, alreadyCached: pool.length - targets.length, generated: fresh.length, failed, force });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    warming = false;
    warmProgress.active = false;
  }
});

// Live progress for an in-flight warm/refresh run, so the UI can show "N / M".
app.get('/api/pool/warm/progress', (req, res) => res.json(warmProgress));

// ── Custom categories (host-authored questions, with optional media DDs) ─────
// Question TEXT persists in the Gist (or a local file fallback); media binaries
// live only in memory (customMedia) and are re-uploaded each session.
const CUSTOM_FILENAME = 'jeopardy-custom.json';
const CUSTOM_PATH = path.join(__dirname, 'custom-categories.json');

async function readGistFile(filename) {
  if (!useGist) return null;
  try {
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `Bearer ${GIST_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) { console.error('Gist read failed:', r.status); return null; }
    const g = await r.json();
    const f = g.files && g.files[filename];
    if (!f) return null;
    let content = f.content;
    // The Gists API truncates a file's inline `content` at ~1 MB and exposes the
    // full body via raw_url — follow it so large shards aren't silently cut off.
    if (f.truncated && f.raw_url) {
      const rr = await fetch(f.raw_url, { headers: { Authorization: `Bearer ${GIST_TOKEN}` } });
      if (rr.ok) content = await rr.text();
    }
    if (content) return JSON.parse(content);
  } catch (e) { console.error('Gist read error:', e.message); }
  return null;
}
async function writeGistFile(filename, data) {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(data, null, 2) } } }),
  });
  if (!r.ok) throw new Error('gist write failed: ' + r.status);
}
async function readCustom() {
  if (useGist) { const d = await readGistFile(CUSTOM_FILENAME); if (Array.isArray(d)) return d; }
  try { return JSON.parse(fs.readFileSync(CUSTOM_PATH, 'utf8')); } catch (e) { return []; }
}
async function writeCustom(list) {
  if (useGist) { await writeGistFile(CUSTOM_FILENAME, list); return; }
  fs.writeFileSync(CUSTOM_PATH, JSON.stringify(list, null, 2) + '\n');
}

// ── Saved boards (a whole configured game: all categories, clues, DDs, Final) ─
// Stored as { "<name>": { savedAt, categories, board, criteria, customCats,
// dailyDoubles, finalJeopardy } } so a host can reload an exact board later
// with no generation.
const BOARDS_FILENAME = 'jeopardy-boards.json';
const BOARDS_PATH = path.join(__dirname, 'saved-boards.json');
async function readBoards() {
  if (useGist) { const d = await readGistFile(BOARDS_FILENAME); if (d && typeof d === 'object') return d; }
  try { return JSON.parse(fs.readFileSync(BOARDS_PATH, 'utf8')); } catch (e) { return {}; }
}
async function writeBoards(obj) {
  if (useGist) { await writeGistFile(BOARDS_FILENAME, obj); return; }
  fs.writeFileSync(BOARDS_PATH, JSON.stringify(obj, null, 2) + '\n');
}

// ── Question-bank cache I/O (sharded across Gist files) ──────────────────────
// A shard is loaded from the Gist at most once per process and merged into
// bankCache; writes re-serialize every cached topic that belongs to that shard.
async function ensureShardLoaded(i) {
  if (loadedShards.has(i)) return;
  if (useGist) {
    const data = await readGistFile(shardFile(i));
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (v && Array.isArray(v.questions)) bankCache.set(k, v);
      }
    }
  }
  loadedShards.add(i);   // mark loaded even without a Gist (local mode = in-memory only)
}

// Return the cached bank for a topic, or null if none has been generated yet.
async function getBank(topic) {
  const key = topicKey(topic);
  if (!key) return null;
  await ensureShardLoaded(shardOf(key));
  return bankCache.get(key) || null;
}

// Persist freshly generated banks. Each entry is { topic, bank }. Touched shards
// are rewritten once apiece (so generating several topics in one shard = 1 write).
async function saveBanks(entries) {
  const dirty = new Set();
  for (const { topic, bank } of entries) {
    const key = topicKey(topic);
    if (!key || !bank) continue;
    await ensureShardLoaded(shardOf(key));
    bankCache.set(key, bank);
    dirty.add(shardOf(key));
  }
  if (!useGist) return;   // local mode keeps banks in memory only (regenerated on restart)
  for (const i of dirty) {
    const obj = {};
    for (const [k, v] of bankCache.entries()) if (shardOf(k) === i) obj[k] = v;
    try { await writeGistFile(shardFile(i), obj); }
    catch (e) { console.error('shard write failed', i, e.message); }
  }
}

// Draw a 5-clue board (easiest→hardest) from a bank: one random unused clue per
// difficulty tier, falling back to neighbouring tiers if a tier is thin.
function drawBoardClues(bank) {
  const qs = (bank && bank.questions) || [];
  if (qs.length < 5) return null;
  const byTier = [[], [], [], [], []];
  qs.forEach(q => { const d = Math.max(1, Math.min(5, Number(q.difficulty) || 3)); byTier[d - 1].push(q); });
  const used = new Set();
  const pick = (tier) => {
    const order = [tier];
    for (let off = 1; off < 5; off++) { if (tier - off >= 0) order.push(tier - off); if (tier + off < 5) order.push(tier + off); }
    for (const t of order) {
      const avail = byTier[t].filter(q => !used.has(q));
      if (avail.length) { const q = avail[Math.floor(Math.random() * avail.length)]; used.add(q); return q; }
    }
    return null;
  };
  const out = [];
  for (let tier = 0; tier < 5; tier++) { const q = pick(tier); if (!q) return null; out.push({ clue: q.clue, answer: q.answer }); }
  return out;
}

// Pull ONE replacement clue from a bank at (or near) a difficulty tier, skipping
// any clue/answer already in `excludeTexts` (normalized) — used by the host's
// per-clue regenerate so it swaps in an unused cached clue, no API call.
function drawReplacementClue(bank, tierIndex, excludeTexts) {
  const qs = (bank && bank.questions) || [];
  if (!qs.length) return null;
  const byTier = [[], [], [], [], []];
  qs.forEach(q => { const d = Math.max(1, Math.min(5, Number(q.difficulty) || 3)); byTier[d - 1].push(q); });
  const tier = Math.max(0, Math.min(4, Number(tierIndex) || 0));
  const order = [tier];
  for (let off = 1; off < 5; off++) { if (tier - off >= 0) order.push(tier - off); if (tier + off < 5) order.push(tier + off); }
  const blocked = excludeTexts || new Set();
  for (const t of order) {
    const avail = byTier[t].filter(q => !blocked.has(normalizeText(q.clue)) && !blocked.has(normalizeText(q.answer)));
    if (avail.length) { const q = avail[Math.floor(Math.random() * avail.length)]; return { clue: q.clue, answer: q.answer }; }
  }
  return null;
}

// Cache-first: draw 5 clues for a topic. On a cache miss, generate a full bank
// (so the NEXT game is token-free too), draw from it, and return it for saving.
// Returns { clues, fresh } where fresh is { topic, bank } when newly generated.
async function getQuestionsForTopic(criteria) {
  const cached = await getBank(criteria);
  const drawn = cached && drawBoardClues(cached);
  if (drawn) return { clues: drawn, fresh: null };
  let bank = null;
  try { bank = { questions: await generateQuestionBank(criteria), generatedAt: Date.now() }; }
  catch (e) { bank = null; }
  const five = (bank && drawBoardClues(bank)) || await generateQuestions(criteria);
  return { clues: five, fresh: bank ? { topic: criteria, bank } : null };
}

app.get('/api/custom', async (req, res) => {
  res.json({ categories: await readCustom() });
});

// List saved boards (names + metadata only, not the full payloads).
app.get('/api/boards', async (req, res) => {
  try {
    const b = await readBoards();
    const boards = Object.keys(b).map(name => ({
      name,
      savedAt: b[name].savedAt || null,
      categories: (b[name].categories && b[name].categories.single) || [],
    })).sort((a, b2) => (b2.savedAt || 0) - (a.savedAt || 0));
    res.json({ boards });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upsert or delete a custom category. body: { category } | { action:'delete', id }
app.post('/api/custom', async (req, res) => {
  const body = req.body || {};
  let list = await readCustom();
  if (body.action === 'delete') {
    list = list.filter(c => c.id !== body.id);
    try { await writeCustom(list); } catch (e) { return res.status(500).json({ error: e.message }); }
    return res.json({ categories: list });
  }
  const cat = body.category;
  if (!cat || !cat.name || !Array.isArray(cat.questions)) return res.status(400).json({ error: 'bad category' });
  const clean = {
    id: (typeof cat.id === 'string' && /^cc_/.test(cat.id)) ? cat.id
      : ('cc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
    name: String(cat.name).trim().slice(0, 60),
    questions: cat.questions.slice(0, 30).map(q => ({
      clue: String(q.clue || '').trim().slice(0, 500),
      answer: String(q.answer || '').trim().slice(0, 300),
      media: (q.media && (q.media.type === 'image' || q.media.type === 'audio'))
        ? { type: q.media.type, name: String(q.media.name || '').slice(0, 120) } : null,
    })).filter(q => q.clue && q.answer),
  };
  if (!clean.name) return res.status(400).json({ error: 'category needs a name' });
  if (clean.questions.length < 5) return res.status(400).json({ error: 'a custom category needs at least 5 complete questions' });
  const i = list.findIndex(c => c.id === clean.id);
  if (i >= 0) list[i] = clean; else list.push(clean);
  try { await writeCustom(list); } catch (e) { return res.status(500).json({ error: 'could not save: ' + e.message }); }
  res.json({ category: clean, categories: list });
});

// Diagnostic: live write/read round-trip against the media repo, so config or
// token-permission problems are visible instead of failing silently on upload.
// Exposes the repo name (not secret) and token LENGTH only — never the token.
app.get('/api/media/diag', async (req, res) => {
  if (!useMediaRepo) return res.json({ useMediaRepo: false, note: 'MEDIA_REPO / MEDIA_TOKEN not set' });
  const out = { useMediaRepo: true, repo: MEDIA_REPO, tokenLen: (MEDIA_TOKEN || '').length };
  try {
    const root = await fetch(`https://api.github.com/repos/${MEDIA_REPO}`, {
      headers: { Authorization: `Bearer ${MEDIA_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    out.repoAccessStatus = root.status;   // 200 ok, 404 = repo/token can't see it, 401 = bad token
    if (root.ok) { const j = await root.json(); out.defaultBranch = j.default_branch; out.private = j.private; }
  } catch (e) { out.repoAccessError = e.message; }
  try {
    await ghPutFile('media/_diag/probe.txt', Buffer.from('ok ' + new Date().toISOString()), 'media diag probe');
    out.write = 'ok';
  } catch (e) { out.write = 'FAILED: ' + e.message; }
  try {
    const rb = await ghContents('media/_diag/probe.txt');
    out.readBack = rb && rb.sha ? 'ok' : 'FAILED: not found';
  } catch (e) { out.readBack = 'FAILED: ' + e.message; }
  res.json(out);
});

// Diagnostic: is persistent (Gist) storage actually configured on this server?
app.get('/api/storage/diag', async (req, res) => {
  let customCount = 0;
  try { customCount = (await readCustom()).length; } catch (e) {}
  res.json({
    useGist,
    hasGistToken: !!GIST_TOKEN,
    hasGistId: !!GIST_ID,
    useMediaRepo,
    customCount,
    note: useGist ? 'persistent (Gist)' : 'EPHEMERAL local file — lost on every redeploy',
    mediaNote: useMediaRepo ? 'media persisted to repo' : 'media is in-memory only — re-upload after each redeploy',
  });
});

// In-memory media for custom-category questions, keyed "<catId>:<qIndex>".
let customMedia = {}; // -> { kind:'image'|'audio', contentType, buffer }

app.get('/api/custommedia/:catId/:qIndex', async (req, res) => {
  const key = req.params.catId + ':' + req.params.qIndex;
  let m = customMedia[key];
  // On a memory miss, backfill from the persisted media repo (survives redeploys).
  if (!m) { m = await fetchPersistedMedia(req.params.catId, req.params.qIndex); if (m) customMedia[key] = m; }
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m.contentType);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(m.buffer);
});

// Durable media upload. REST (not a socket) so a flaky mobile connection can't
// silently drop it, and we AWAIT the repo persist to report the real result.
// The data URL is sent as text/plain so the global 100 KB express.json()
// middleware ignores it; this route parses up to 8 MB.
app.post('/api/custommedia/:catId/:qIndex', express.text({ limit: '8mb' }), async (req, res) => {
  const dataUrl = typeof req.body === 'string' ? req.body : '';
  const m = dataUrl.match(/^data:(image\/[\w.+-]+|audio\/[\w.+-]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ ok: false, error: 'bad data url' });
  const contentType = m[1];
  const kind = contentType.startsWith('image/') ? 'image' : 'audio';
  const buf = Buffer.from(m[2], 'base64');
  const cap = kind === 'image' ? 600000 : 4000000; // ~600KB image, ~4MB audio
  if (buf.length === 0 || buf.length > cap) return res.status(413).json({ ok: false, tooBig: buf.length > cap });
  const { catId, qIndex } = req.params;
  customMedia[String(catId) + ':' + String(qIndex)] = { kind, contentType, buffer: buf };
  const persisted = await persistMedia(String(catId), String(qIndex), contentType, buf);
  res.json({ ok: true, persisted, useMediaRepo });
});

let lastTtsError = 'none yet';   // surfaced via /api/tts/diag for debugging

const TTS_TIMEOUT_MS = 15000;   // per-attempt cap (generous for Render cold starts)

// One ElevenLabs attempt. Returns { buffer } on success, or { retriable } on
// failure. Transient problems (timeout, 429, 5xx) are retriable; auth/quota/bad
// request (other 4xx) are not — retrying those just wastes time.
async function ttsAttempt(text, voiceId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
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
      return { retriable: response.status === 429 || response.status >= 500 };
    }
    lastTtsError = 'ok';
    return { buffer: Buffer.from(await response.arrayBuffer()) };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    lastTtsError = aborted ? `timed out after ${TTS_TIMEOUT_MS}ms` : 'fetch threw: ' + (err && err.message ? err.message : String(err));
    console.error('TTS error:', lastTtsError);
    return { retriable: true };   // timeout / network blip → worth one retry
  } finally {
    clearTimeout(timer);
  }
}

// Generate clue audio via ElevenLabs (128kbps CBR mp3). Returns a Buffer or null.
// Retries once on a transient failure (e.g. a Render cold start timing out the
// first call); on permanent failure we just proceed with on-screen text + cue.
async function generateTTS(text) {
  if (!process.env.ELEVENLABS_API_KEY) { lastTtsError = 'ELEVENLABS_API_KEY not set on server'; return null; }
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'VR6AewLTigWG4xSOukaG'; // Arnold (announcer)
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ttsAttempt(text, voiceId);
    if (r.buffer) return r.buffer;
    if (!r.retriable) return null;
  }
  return null;
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

// Diagnostic: why TTS is/ isn't working (no secrets leaked).
app.get('/api/tts/diag', (req, res) => {
  res.json({
    hasKey: !!process.env.ELEVENLABS_API_KEY,
    keyLen: process.env.ELEVENLABS_API_KEY ? process.env.ELEVENLABS_API_KEY.trim().length : 0,
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'VR6AewLTigWG4xSOukaG (default)',
    lastTtsError,
    haveCurrentAudio: !!currentAudio,
  });
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
  return { enforceEarlyPenalty: true, buzzTimeoutMs: DEFAULT_BUZZ_MS, finalAnswerMs: DEFAULT_FINAL_MS, voiceMode: 'elevenlabs' };
}

// Only the 'elevenlabs' voice mode hits the paid TTS API; 'browser' and 'off'
// skip it (saving credits) — the client handles browser speech / silence.
function useElevenLabs() {
  return (gameState.settings.voiceMode || 'elevenlabs') === 'elevenlabs';
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
  criteria: { single: {}, double: {} },   // name -> generation criteria (for regen)
  customCats: {},            // "round|name" -> true for host-authored custom categories
  regenerating: {},          // "round|name" -> true while a category re-rolls in review
  regeneratingClues: {},     // "round|name|index" -> true while a single clue re-rolls in review
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
  const buffer = useElevenLabs() ? await generateTTS(q.clue) : null;
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
    criteria: { single: {}, double: {} },
    customCats: {},
    regenerating: {},
    regeneratingClues: {},
    finalCategory: null,
    finalJeopardy: null,
    finalRegenerating: false,
    final: null,
  };
}

// Strip everything a contestant must not see from a state clone: clue/answer
// text, the current clue's answer (until revealed), the pre-game final clue,
// generation criteria, daily-double locations, and the final correct answer
// (until the reveal). Per-player wagers/answers are refilled in broadcastState.
function redactForPlayers(v) {
  for (const round of ['single', 'double']) {
    const b = v.board && v.board[round];
    if (b) for (const k of Object.keys(b)) if (Array.isArray(b[k])) b[k] = b[k].map(() => ({}));
  }
  if (v.currentQuestion && !v.currentQuestion.revealed) delete v.currentQuestion.answer;
  v.finalJeopardy = null;
  v.criteria = { single: {}, double: {} };
  v.dailyDoubles = [];
  if (v.final) {
    if (v.final.stage !== 'reveal') delete v.final.answer;
    v.final.wagers = {};
    v.final.answers = {};
  }
  return v;
}

function broadcastState() {
  // The host runs the game and may see everything; contestants get a redacted
  // view so answers can't be read out of the broadcast state.
  const full = JSON.parse(JSON.stringify({ ...gameState, lockUntil }));
  if (gameState.hostId) io.to(gameState.hostId).emit('state', full);

  const common = redactForPlayers(JSON.parse(JSON.stringify(full)));
  const f = gameState.final;

  io.of('/').sockets.forEach((sock, sid) => {
    if (sid === gameState.hostId) return;     // already sent the full state
    if (!f) { sock.emit('state', common); return; }
    // Each player additionally sees only their OWN wager/answer, plus any the
    // host has already revealed during the spotlight.
    const v = JSON.parse(JSON.stringify(common));
    const w = {}, a = {};
    Object.keys(f.wagers).forEach(id => { if (id === sid || (f.reveal[id] && f.reveal[id].wager)) w[id] = f.wagers[id]; });
    Object.keys(f.answers).forEach(id => { if (id === sid || (f.reveal[id] && f.reveal[id].answer)) a[id] = f.answers[id]; });
    v.final.wagers = w;
    v.final.answers = a;
    sock.emit('state', v);
  });
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
    spotlight: 0,              // index into revealOrder: which contestant is on screen
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

// Generate a CACHEABLE bank of ~30 clues for a category, spread across 5
// difficulty tiers (perTier each). Returns [{clue, answer, difficulty:1..5}].
// Leaking clues are dropped; we keep the cleanest attempt and require every
// tier represented plus a healthy total, so drawBoardClues can always fill 5.
async function generateQuestionBank(category, perTier = 6) {
  const prompt = `You are writing a large bank of Jeopardy! clues for the category "${category}".

Write ${perTier} clues at EACH of 5 difficulty tiers (tier 1 = easiest/most accessible, tier 5 = hardest), for ${perTier * 5} clues total. In Jeopardy! the host READS a clue (a statement) and players respond with a QUESTION ("What is...?").

ACCURACY IS CRITICAL: state only facts you are highly confident are true. Mentally fact-check each clue and fix anything uncertain. Avoid obscure stats, exact dates, or records you might misremember.

NEVER GIVE AWAY THE ANSWER: the answer must NOT appear anywhere in its own clue, and a clue must not simply restate the category name.

VARIETY: make the clues distinct from one another — different facts, people, works, events — so the bank stays fresh across many games. No two clues should have the same answer.

Return ONLY valid JSON, no other text:
{"clues":[{"clue":"...","answer":"What is ...?","difficulty":1}, ... ]}

Rules:
- each clue is a statement/description, NOT a question
- each answer is phrased "What is X?" or "Who is X?"
- difficulty is an integer 1-5
- the answer (and the category name) must never appear in the clue text
- concise and unambiguous`;

  let lastErr, best = [], bestScore = -1;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await client.messages.create(
        { model: 'claude-sonnet-4-6', max_tokens: 5000, messages: [{ role: 'user', content: prompt }] },
        { timeout: 90000, maxRetries: 1 }
      );
      const raw = JSON.parse(extractJSON(resp.content[0].text.trim())).clues;
      if (!Array.isArray(raw)) throw new Error('unexpected bank shape');
      const clean = raw
        .filter(q => q && typeof q.clue === 'string' && typeof q.answer === 'string')
        .map(q => ({ clue: q.clue, answer: q.answer, difficulty: Math.max(1, Math.min(5, Number(q.difficulty) || 3)) }))
        .filter(q => !clueLeaks(q.clue, q.answer, category));
      const tiers = new Set(clean.map(q => q.difficulty));
      const score = clean.length + tiers.size * 100;   // prefer full tier coverage, then volume
      if (score > bestScore) { best = clean; bestScore = score; }
      if (clean.length >= Math.round(perTier * 5 * 0.7) && tiers.size === 5) return clean;
      throw new Error(`bank too thin (${clean.length} clues, ${tiers.size}/5 tiers)`);
    } catch (err) {
      lastErr = err;
      console.error(`bank "${category}" attempt ${attempt + 1} failed:`, err.message);
    }
  }
  // Accept the best usable attempt (enough to draw a board), else fail.
  if (best.length >= 5 && new Set(best.map(q => q.difficulty)).size >= 1) return best;
  throw lastErr || new Error('could not build a question bank');
}

// Regenerate ONE board clue for a category, at the difficulty of its slot
// (index 0 = easiest .. 4 = hardest), avoiding the other clues already in the
// category. Returns { clue, answer }. Same self-verifying / leak-check retries.
async function generateSingleClue(category, index, others) {
  const i = Math.max(0, Math.min(4, Number(index) || 0));
  const difficulty = ['the easiest, most accessible', 'easy', 'medium', 'hard', 'the hardest'][i];
  const avoid = (others || [])
    .filter(c => c && c.clue)
    .map(c => `- ${c.clue}  (answer: ${c.answer})`)
    .join('\n');
  const prompt = `You are rewriting ONE clue for a category in a game of Jeopardy!: "${category}".

This is clue ${i + 1} of 5, which should be ${difficulty} of the five (clue 1 is easiest, clue 5 is hardest). In Jeopardy! the host READS a clue (a statement) and players respond with a QUESTION ("What is...?").

ACCURACY IS CRITICAL: state only facts you are highly confident are true. Mentally fact-check the clue and fix anything uncertain before answering. Avoid obscure stats, exact dates, or records you might misremember.

NEVER GIVE AWAY THE ANSWER: the answer must NOT appear anywhere in the clue, and the clue must not simply restate the category name.

Write a FRESH clue that does NOT duplicate any of these existing clues already in this category:
${avoid || '(none)'}

Return ONLY valid JSON, no other text:
{"clue":"...","answer":"What is ...?"}

Rules:
- the clue is a statement/description, NOT a question
- the answer is phrased "What is X?" or "Who is X?"
- the answer (and the category name) must never appear in the clue text
- concise and unambiguous`;

  let lastErr, best = null, bestLeaks = Infinity;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await client.messages.create(
        { model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] },
        { timeout: 45000, maxRetries: 1 }
      );
      const obj = JSON.parse(extractJSON(resp.content[0].text.trim()));
      if (!obj || typeof obj.clue !== 'string' || typeof obj.answer !== 'string') throw new Error('unexpected clue shape');
      const one = { clue: obj.clue, answer: obj.answer };
      const leaks = clueLeaks(one.clue, one.answer, category) ? 1 : 0;
      if (leaks < bestLeaks) { best = one; bestLeaks = leaks; }
      if (leaks === 0) return one;
      throw new Error('answer leaked into the clue');
    } catch (err) {
      lastErr = err;
      console.error(`regenerate one clue "${category}" #${i} attempt ${attempt + 1} failed:`, err.message);
    }
  }
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

// Pick `count` daily-double squares from a board, tagged with their round.
// Excludes the top row (valueIndex 0), like the show.
function pickDailyDoubles(board, count, round, exclude) {
  const squares = [];
  for (const cat of Object.keys(board)) {
    for (let i = 1; i < 5; i++) {
      if (exclude && exclude.has(cat + '|' + i)) continue;   // already a (media) DD
      squares.push({ round, cat, valueIndex: i });
    }
  }
  for (let i = squares.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [squares[i], squares[j]] = [squares[j], squares[i]];
  }
  return squares.slice(0, count);
}

// Fisher-Yates shuffle (returns a new array).
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build a board category (5 clues) from a saved custom category. Always include
// media questions (they're the daily doubles), then fill randomly to 5. Returns
// { clues, mediaSlots } where mediaSlots are the value indexes carrying media.
function buildCustomCategory(cat) {
  const withIdx = cat.questions.map((q, idx) => ({ q, idx }));
  const mediaQs = withIdx.filter(x => x.q && x.q.media);
  const rest = shuffled(withIdx.filter(x => !(x.q && x.q.media)));
  const chosen = [...mediaQs, ...rest].slice(0, 5);
  const clues = chosen.map(({ q, idx }) => ({
    clue: q.clue,
    answer: q.answer,
    media: q.media ? { type: q.media.type, catId: cat.id, qIndex: idx } : undefined,
  }));
  const mediaSlots = [];
  clues.forEach((c, slot) => { if (c.media) mediaSlots.push(slot); });
  return { clues, mediaSlots };
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);
  // Send current state immediately so a just-arrived guest can decide the
  // title-screen gate (waiting vs. brief splash) before they join.
  broadcastState();

  // Test-only hook (inert unless TEST_HOOKS=1) to inject a board without the API
  if (process.env.TEST_HOOKS === '1') {
    socket.on('__test_inject', ({ board, phase, settings, dailyDoubles, finalJeopardy, criteria }) => {
      gameState.board.single = board;
      gameState.board.double = board;
      gameState.dailyDoubles = dailyDoubles || [];
      gameState.categories = Object.keys(board);
      if (settings) gameState.settings = { ...gameState.settings, ...settings };
      if (finalJeopardy) gameState.finalJeopardy = finalJeopardy;
      if (criteria) gameState.criteria = criteria;
      const ph = phase || 'single';
      if (ph === 'final') { startFinalRound(); return; }   // builds gameState.final
      gameState.phase = ph;
      broadcastState();
    });
  }

  socket.on('join', ({ name, isHost }) => {
    // The host is a pure operator — track the socket as hostId, but never add it
    // to gameState.players (no score/photo, never shown in player lists).
    if (isHost) {
      gameState.hostId = socket.id;
      if (gameState.phase === 'lobby') gameState.phase = 'setup';
      socket.emit('joined', { id: socket.id });
      broadcastState();
      return;
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
      // If a Final Jeopardy round is live, carry the player's slot to the new id
      // so wagers/answers/eligibility keep working after a reconnect.
      const f = gameState.final;
      if (f) {
        [f.eligible, f.revealOrder].forEach(arr => {
          if (!arr) return;
          const i = arr.indexOf(existingId);
          if (i >= 0) arr[i] = socket.id;
        });
        ['wagers', 'answers', 'answered', 'reveal'].forEach(k => {
          if (f[k] && Object.prototype.hasOwnProperty.call(f[k], existingId)) {
            f[k][socket.id] = f[k][existingId];
            delete f[k][existingId];
          }
        });
        if (f.winnerId === existingId) f.winnerId = socket.id;
      }
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
    // If this socket isn't (yet) recognized as the host — e.g. it reconnected
    // with a new id — nudge it to re-join rather than silently doing nothing.
    if (socket.id !== gameState.hostId) {
      socket.emit('rejoin');
      socket.emit('error', { message: 'Reconnected — please tap "Generate Questions" again.' });
      return;
    }
    // Apply per-game settings from the setup screen
    if (settings) {
      gameState.settings = {
        enforceEarlyPenalty: settings.enforceEarlyPenalty !== false,
        buzzTimeoutMs: Math.max(2000, Math.min(60000, Number(settings.buzzTimeoutMs) || DEFAULT_BUZZ_MS)),
        finalAnswerMs: Math.max(5000, Math.min(180000, Number(settings.finalAnswerMs) || DEFAULT_FINAL_MS)),
        voiceMode: ['elevenlabs', 'browser', 'off'].includes(settings.voiceMode) ? settings.voiceMode : 'elevenlabs',
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

    // Each slot is either an AI category { criteria, name } or a saved custom
    // category { customId }. Load custom categories up front.
    const customList = await readCustom();
    const normSlot = (c) => {
      if (c && typeof c === 'object' && c.customId) {
        const cat = customList.find(x => x.id === c.customId);
        return cat ? { custom: cat } : null;
      }
      if (typeof c === 'string') return { criteria: c, name: c };
      const name = (c.name || c.criteria || '').trim();
      return name ? { criteria: (c.criteria || c.name || '').trim(), name } : null;
    };
    const singles = (singleCategories || []).map(normSlot).filter(Boolean);
    const doubles = (doubleCategories || []).map(normSlot).filter(Boolean);

    if (!singles.length || !doubles.length) {
      // e.g. a chosen custom category is no longer in the store.
      socket.emit('error', { message: 'Could not start: a selected category is missing. Re-pick categories and try again.' });
      return;
    }

    gameState.phase = 'generating';
    gameState.categories = singles.map(c => c.custom ? c.custom.name : c.name);

    // Only AI categories need generation; custom ones are placed instantly.
    const tasks = [
      ...singles.filter(c => !c.custom).map(c => ({ round: 'single', name: c.name, criteria: c.criteria })),
      ...doubles.filter(c => !c.custom).map(c => ({ round: 'double', name: c.name, criteria: c.criteria })),
      { round: 'final' },
    ];
    gameState.genProgress = { done: 0, total: tasks.length };
    broadcastState();

    const aiSingle = {}, aiDouble = {};
    let finalClue = null;
    const failures = [];
    const freshBanks = [];   // newly generated banks to persist to the cache after

    await runWithConcurrency(tasks, 6, async (t) => {
      try {
        if (t.round === 'final') {
          finalClue = manualFinal ? manualFinal : await generateFinalClue(gameState.finalCategory);
        } else {
          // Cache-first: draws from a stored bank when available (no API call),
          // otherwise generates a bank and queues it to be saved.
          const { clues, fresh } = await getQuestionsForTopic(t.criteria);
          (t.round === 'single' ? aiSingle : aiDouble)[t.name] = clues;
          if (fresh) freshBanks.push(fresh);
        }
      } catch (err) {
        failures.push(t.round === 'final' ? 'Final Jeopardy' : t.name);
      }
      gameState.genProgress.done++;
      broadcastState();
    });

    // Persist any newly built banks in the background so the host isn't blocked
    // on Gist writes — the next game of these topics will play token-free.
    if (freshBanks.length) saveBanks(freshBanks).catch(e => console.error('bank persist failed:', e.message));

    if (failures.length) {
      console.error('Failed categories:', failures.join(', '));
      socket.emit('error', { message: `Could not generate: ${failures.join(', ')}. Please try again.` });
      gameState.phase = 'setup';
      gameState.genProgress = null;
      broadcastState();
      return;
    }

    // Assemble each round's board in slot order (custom + AI), tracking custom
    // categories and the media squares that become daily doubles.
    const singleBoard = {}, doubleBoard = {};
    const singleCrit = {}, doubleCrit = {};
    const customCats = {};
    const mediaDDs = [];
    const assemble = (slots, round, board, crit, aiMap) => {
      slots.forEach(c => {
        if (c.custom) {
          const built = buildCustomCategory(c.custom);
          board[c.custom.name] = built.clues;
          customCats[round + '|' + c.custom.name] = true;
          built.mediaSlots.forEach(vi => mediaDDs.push({ round, cat: c.custom.name, valueIndex: vi }));
        } else {
          board[c.name] = aiMap[c.name];
          crit[c.name] = c.criteria;
        }
      });
    };
    assemble(singles, 'single', singleBoard, singleCrit, aiSingle);
    assemble(doubles, 'double', doubleBoard, doubleCrit, aiDouble);

    gameState.board.single = singleBoard;
    gameState.board.double = doubleBoard;
    gameState.criteria = { single: singleCrit, double: doubleCrit };
    gameState.customCats = customCats;
    // Media questions are daily doubles; add the standard random DDs among the
    // remaining (non-media) squares.
    const exSingle = new Set(mediaDDs.filter(d => d.round === 'single').map(d => d.cat + '|' + d.valueIndex));
    const exDouble = new Set(mediaDDs.filter(d => d.round === 'double').map(d => d.cat + '|' + d.valueIndex));
    gameState.dailyDoubles = [
      ...mediaDDs,
      ...pickDailyDoubles(singleBoard, 1, 'single', exSingle),
      ...pickDailyDoubles(doubleBoard, 2, 'double', exDouble),
    ];
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

  // Host re-rolls one board category's clues from its stored criteria (review only).
  socket.on('regenerateCategory', async ({ round, name }) => {
    if (socket.id !== gameState.hostId || gameState.phase !== 'review') return;
    if (round !== 'single' && round !== 'double') return;
    if (gameState.customCats[round + '|' + name]) return;   // custom categories aren't AI-regenerated
    const board = gameState.board[round];
    if (!board || !(name in board)) return;
    const criteria = (gameState.criteria[round] && gameState.criteria[round][name]) || name;
    const key = round + '|' + name;
    gameState.regenerating[key] = true;
    broadcastState();
    try {
      // Re-draw a fresh 5-clue board from the cached bank (no API call). Only if
      // the topic has no bank yet do we generate one (and cache it for next time).
      const bank = await getBank(criteria);
      let clues = bank && drawBoardClues(bank);
      let fresh = null;
      if (!clues) {
        const r = await getQuestionsForTopic(criteria);
        clues = r.clues; fresh = r.fresh;
      }
      if (gameState.phase === 'review' && gameState.board[round] && (name in gameState.board[round])) {
        gameState.board[round][name] = clues;
      }
      if (fresh) saveBanks([fresh]).catch(e => console.error('bank persist failed:', e.message));
    } catch (e) {
      socket.emit('error', { message: `Could not regenerate "${name}". Try again.` });
    } finally {
      delete gameState.regenerating[key];
      broadcastState();
    }
  });

  // Host reorders a clue within its category during review, swapping its point
  // value with the neighbour (dir 'up' = lower value, 'down' = higher value).
  socket.on('moveClue', ({ round, name, index, dir }) => {
    if (socket.id !== gameState.hostId || gameState.phase !== 'review') return;
    if (round !== 'single' && round !== 'double') return;
    const clues = gameState.board[round] && gameState.board[round][name];
    if (!Array.isArray(clues)) return;
    const i = Number(index);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || i >= clues.length || j < 0 || j >= clues.length) return;
    [clues[i], clues[j]] = [clues[j], clues[i]];
    broadcastState();
  });

  // Host edits a single clue's wording and/or answer during review. The clue's
  // media (custom daily double) and any other props are preserved.
  socket.on('editClue', ({ round, name, index, clue, answer }) => {
    if (socket.id !== gameState.hostId || gameState.phase !== 'review') return;
    if (round !== 'single' && round !== 'double') return;
    const clues = gameState.board[round] && gameState.board[round][name];
    if (!Array.isArray(clues)) return;
    const i = Number(index);
    if (i < 0 || i >= clues.length || !clues[i]) return;
    if (typeof clue === 'string') clues[i].clue = clue.slice(0, 600);
    if (typeof answer === 'string') clues[i].answer = answer.slice(0, 200);
    broadcastState();
  });

  // Host regenerates just ONE clue (at its difficulty slot) based on the
  // category's criteria. Custom-category and media clues are not AI-generated.
  socket.on('regenerateClue', async ({ round, name, index }) => {
    if (socket.id !== gameState.hostId || gameState.phase !== 'review') return;
    if (round !== 'single' && round !== 'double') return;
    if (gameState.customCats[round + '|' + name]) return;
    const board = gameState.board[round];
    if (!board || !(name in board)) return;
    const clues = board[name];
    const i = Number(index);
    if (!Array.isArray(clues) || i < 0 || i >= clues.length || !clues[i]) return;
    if (clues[i].media) return;   // don't regenerate a media daily double
    const criteria = (gameState.criteria[round] && gameState.criteria[round][name]) || name;
    const key = round + '|' + name + '|' + i;
    gameState.regeneratingClues[key] = true;
    broadcastState();
    try {
      // Swap in an unused clue from the cached bank at this slot's difficulty
      // tier (no API call). Generate a single fresh clue only if there's no bank
      // or the bank has nothing left that isn't already on the board.
      const exclude = new Set();
      clues.forEach(c => { if (c && c.clue) exclude.add(normalizeText(c.clue)); if (c && c.answer) exclude.add(normalizeText(c.answer)); });
      const bank = await getBank(criteria);
      let fresh = bank && drawReplacementClue(bank, i, exclude);
      if (!fresh) fresh = await generateSingleClue(criteria, i, clues.filter((_, idx) => idx !== i));
      const cur = gameState.board[round] && gameState.board[round][name];
      if (gameState.phase === 'review' && Array.isArray(cur) && cur[i]) {
        cur[i] = { ...cur[i], clue: fresh.clue, answer: fresh.answer };
      }
    } catch (e) {
      socket.emit('error', { message: `Could not regenerate that clue. Try again.` });
    } finally {
      delete gameState.regeneratingClues[key];
      broadcastState();
    }
  });

  socket.on('beginRounds', () => {
    if (socket.id !== gameState.hostId || gameState.phase !== 'review') return;
    gameState.phase = 'single';
    // Seed board control ONCE at the first round's start: a random contestant
    // "has the board." Thereafter it passes to whoever last answers correctly.
    const contestants = Object.keys(gameState.players);
    gameState.boardControl = contestants.length
      ? contestants[Math.floor(Math.random() * contestants.length)]
      : null;
    broadcastState();
  });

  // Save the fully-configured board (all categories, clues, DDs, Final) under a
  // name so it can be reloaded exactly later with no generation.
  socket.on('saveBoard', async ({ name } = {}) => {
    if (socket.id !== gameState.hostId) return;
    if (!gameState.board.single || !gameState.board.double) {
      return socket.emit('error', { message: 'Build a board first, then save it.' });
    }
    const nm = String(name || '').trim().slice(0, 60);
    if (!nm) return socket.emit('error', { message: 'Give the board a name.' });
    try {
      const boards = await readBoards();
      boards[nm] = {
        savedAt: Date.now(),
        categories: { single: Object.keys(gameState.board.single || {}), double: Object.keys(gameState.board.double || {}) },
        board: gameState.board,
        criteria: gameState.criteria,
        customCats: gameState.customCats,
        dailyDoubles: gameState.dailyDoubles,
        finalJeopardy: gameState.finalJeopardy,
      };
      await writeBoards(boards);
      socket.emit('boardSaved', { name: nm });
    } catch (e) {
      socket.emit('error', { message: 'Could not save board: ' + e.message });
    }
  });

  // Load a saved board straight into the review screen (no generation, no
  // tokens). The host can then tweak and Start Game.
  socket.on('loadBoard', async ({ name } = {}) => {
    if (socket.id !== gameState.hostId) return;
    const nm = String(name || '').trim();
    try {
      const boards = await readBoards();
      const b = boards[nm];
      if (!b || !b.board || !b.board.single) return socket.emit('error', { message: 'That saved board is missing.' });
      clearQuestionTimeout();
      clearFinalTimeout();
      gameState.board = b.board;
      gameState.criteria = b.criteria || { single: {}, double: {} };
      gameState.customCats = b.customCats || {};
      gameState.dailyDoubles = b.dailyDoubles || [];
      gameState.finalJeopardy = b.finalJeopardy || null;
      gameState.categories = Object.keys(b.board.single || {});
      gameState.usedSquares = { single: {}, double: {} };
      gameState.regenerating = {};
      gameState.regeneratingClues = {};
      gameState.currentQuestion = null;
      gameState.buzzers = [];
      gameState.buzzOpen = false;
      gameState.dailyDoubleWager = null;
      gameState.boardControl = null;
      gameState.final = null;
      gameState.genProgress = null;
      gameState.phase = 'review';
      broadcastState();
      socket.emit('boardLoaded', { name: nm });
    } catch (e) {
      socket.emit('error', { message: 'Could not load board: ' + e.message });
    }
  });

  socket.on('deleteBoard', async ({ name } = {}) => {
    if (socket.id !== gameState.hostId) return;
    try {
      const boards = await readBoards();
      delete boards[String(name || '').trim()];
      await writeBoards(boards);
      socket.emit('boardsChanged');
    } catch (e) {
      socket.emit('error', { message: 'Could not delete board: ' + e.message });
    }
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
    const buffer = useElevenLabs() ? await generateTTS(f.clue) : null;
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
    f.spotlight = 0;            // start the dramatic reveal on the lowest scorer
    currentAudio = null;
    broadcastState();
  });

  // Advance the spotlight to the next contestant in the reveal.
  socket.on('nextFinalContestant', () => {
    if (socket.id !== gameState.hostId) return;
    const f = gameState.final;
    if (!f || f.stage !== 'reveal') return;
    if (f.spotlight < f.revealOrder.length - 1) { f.spotlight++; broadcastState(); }
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

  // (Custom-category media now uploads via POST /api/custommedia/:catId/:qIndex,
  // which awaits the durable repo persist and reports success — more reliable
  // than a socket on flaky mobile connections.)

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

    const isDailyDouble =
      gameState.dailyDoubles.some(dd => dd.round === round && dd.cat === category && dd.valueIndex === valueIndex);

    clearQuestionTimeout();
    lockUntil = {};
    pendingBuzzes = [];
    gameState.usedSquares[round][key] = true;
    gameState.currentQuestion = {
      round, category, valueIndex, dollarValue,
      clue: clue.clue, answer: clue.answer, media: clue.media || null, isDailyDouble,
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
    if (!player) { socket.emit('rejoin'); return; }   // reconnected w/ a new id → re-bind
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
    // If our host binding is stale (silent reconnect), nudge a re-join so the
    // client re-claims host and the tap can be retried, instead of no-oping.
    if (socket.id !== gameState.hostId) { socket.emit('rejoin'); return; }
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
    gameState.criteria = { single: {}, double: {} };
    gameState.customCats = {};
    gameState.regenerating = {};
    gameState.regeneratingClues = {};
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
