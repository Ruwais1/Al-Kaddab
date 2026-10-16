'use strict';
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const QUESTIONS = require('./questions');

// ===== الإعدادات =====
const PORT = process.env.PORT || 3000;
const WRITE_SECONDS = Number(process.env.WRITE_SECONDS) || 60;
const VOTE_SECONDS = Number(process.env.VOTE_SECONDS) || 30;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_NAME = 14;
const MAX_LIE = 40;
const TRUTH_POINTS = 2; // لمن يختار الصح
const FOOL_POINTS = 1;  // لصاحب الكذبة عن كل شخص انخدع فيها
const ROUND_CHOICES = [3, 5, 7, 10];

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PUBLIC = path.join(__dirname, 'Public');

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'player.html')));
app.get('/host', (req, res) => res.sendFile(path.join(PUBLIC, 'host.html')));
app.use(express.static(PUBLIC, { index: false }));

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return null;
}

// الباركود: على Render ياخذ رابط الموقع، وفي البيت يحوّل localhost إلى عنوان اللابتوب على الواي فاي
app.get('/qr', async (req, res) => {
  try {
    let url = process.env.PUBLIC_URL;
    if (!url) {
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
      const u = new URL(`${proto}://${req.headers.host}`);
      if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
        const ip = lanAddress();
        if (ip) u.hostname = ip;
      }
      url = u.origin + '/';
    }
    const dataUrl = await QRCode.toDataURL(url, {
      margin: 1,
      width: 520,
      color: { dark: '#1B2A4EFF', light: '#F6E7C8FF' },
    });
    res.json({ url, dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'qr' });
  }
});

// ===== حالة اللعبة (موجودة في السيرفر فقط) =====
const game = {
  phase: 'lobby', // lobby | writing | voting | reveal | final
  players: new Map(), // id -> { id, name, score, connected, socketId }
  rounds: 5,
  round: 0,
  used: new Set(),
  question: null,
  lies: new Map(), // playerId -> text
  options: [], // { id, text, truth, authors, voters }
  votes: new Map(), // playerId -> optionId
  gains: {},
  deadline: 0,
  duration: 0,
};
const tokens = new Map(); // رمز سري محفوظ في الجوال -> playerId
let timer = null;

const connectedPlayers = () => [...game.players.values()].filter((p) => p.connected);

// توحيد الكتابة العربية عشان "أسود" و"اسود" و"الأسود" تُحسب نفس الشي
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .map((w) => w.replace(/^ال(?=..)/, ''))
    .join('');
}

function isTruth(text) {
  const n = normalize(text);
  return [game.question.a, ...(game.question.alt || [])].some((x) => normalize(x) === n);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickQuestion() {
  let pool = QUESTIONS.map((_, i) => i).filter((i) => !game.used.has(i));
  if (!pool.length) {
    game.used.clear();
    pool = QUESTIONS.map((_, i) => i);
  }
  const i = pool[Math.floor(Math.random() * pool.length)];
  game.used.add(i);
  return QUESTIONS[i];
}

function setPhase(phase, seconds = 0) {
  clearTimeout(timer);
  timer = null;
  game.phase = phase;
  game.duration = seconds * 1000;
  game.deadline = seconds ? Date.now() + game.duration : 0;
  if (seconds) timer = setTimeout(onTimeout, game.duration);
  broadcast();
}

function onTimeout() {
  if (game.phase === 'writing') startVoting();
  else if (game.phase === 'voting') reveal();
}

function startGame(rounds) {
  for (const [id, p] of game.players) if (!p.connected) game.players.delete(id);
  for (const [t, id] of tokens) if (!game.players.has(id)) tokens.delete(t);
  for (const p of game.players.values()) p.score = 0;
  game.rounds = rounds;
  game.round = 0;
  nextRound();
}

function nextRound() {
  game.round++;
  game.question = pickQuestion();
  game.lies.clear();
  game.votes.clear();
  game.options = [];
  game.gains = {};
  setPhase('writing', WRITE_SECONDS);
}

function startVoting() {
  const opts = [{ text: game.question.a, truth: true, authors: [] }];
  for (const [pid, text] of game.lies) opts.push({ text, truth: false, authors: [pid] });
  game.options = shuffle(opts).map((o, i) => ({ ...o, id: 'o' + i, voters: [] }));
  setPhase('voting', VOTE_SECONDS);
}

function reveal() {
  const gains = {};
  for (const p of game.players.values()) gains[p.id] = 0;
  for (const [pid, oid] of game.votes) {
    const o = game.options.find((x) => x.id === oid);
    if (!o) continue;
    o.voters.push(pid);
    if (o.truth) gains[pid] = (gains[pid] || 0) + TRUTH_POINTS;
    else for (const a of o.authors) if (a !== pid) gains[a] = (gains[a] || 0) + FOOL_POINTS;
  }
  for (const [pid, g] of Object.entries(gains)) {
    const p = game.players.get(pid);
    if (p) p.score += g;
  }
  game.gains = gains;
  setPhase('reveal');
}

function backToLobby() {
  game.round = 0;
  game.question = null;
  game.lies.clear();
  game.votes.clear();
  game.options = [];
  game.gains = {};
  for (const p of game.players.values()) p.score = 0;
  setPhase('lobby');
}

// إذا الكل خلّص قبل الوقت، ننتقل مباشرة. ترجع true إذا انتقلت المرحلة.
function checkProgress() {
  const active = connectedPlayers();
  if (!active.length) return false;
  if (game.phase === 'writing' && active.every((p) => game.lies.has(p.id))) {
    startVoting();
    return true;
  }
  if (game.phase === 'voting' && active.every((p) => game.votes.has(p.id))) {
    reveal();
    return true;
  }
  return false;
}

// ===== اللي ينرسل للأجهزة =====
function snapshot() {
  const g = game;
  const s = {
    phase: g.phase,
    round: g.round,
    rounds: g.rounds,
    remaining: g.deadline ? Math.max(0, g.deadline - Date.now()) : 0,
    duration: g.duration,
    minPlayers: MIN_PLAYERS,
    maxLie: MAX_LIE,
    maxName: MAX_NAME,
    players: [...g.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      done: g.phase === 'writing' ? g.lies.has(p.id) : g.phase === 'voting' ? g.votes.has(p.id) : false,
    })),
    question: g.question && g.phase !== 'lobby' ? g.question.q : null,
  };
  // وقت التصويت: نرسل النصوص فقط، بدون مين كتبها ولا وين الصح
  if (g.phase === 'voting') s.options = g.options.map((o) => ({ id: o.id, text: o.text }));
  if (g.phase === 'reveal') {
    s.options = g.options.map((o) => ({ id: o.id, text: o.text, truth: o.truth, authors: o.authors, voters: o.voters }));
    s.gains = g.gains;
  }
  return s;
}

function meView(p) {
  const own = game.options.find((o) => o.authors.includes(p.id));
  return {
    id: p.id,
    name: p.name,
    score: p.score,
    lie: game.lies.get(p.id) || null,
    vote: game.votes.get(p.id) || null,
    ownOption: own ? own.id : null,
    gain: game.phase === 'reveal' ? game.gains[p.id] || 0 : null,
  };
}

function broadcast() {
  const s = snapshot();
  io.to('hosts').emit('state', s);
  for (const p of game.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', { ...s, me: meView(p) });
  }
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

io.on('connection', (socket) => {
  const ack = (cb) => (typeof cb === 'function' ? cb : () => {});
  const isHost = () => socket.rooms.has('hosts');
  const me = () => game.players.get(socket.data.playerId);

  // ----- الشاشة -----
  socket.on('host:hello', () => {
    socket.join('hosts');
    socket.emit('state', snapshot());
  });

  socket.on('host:start', (opts) => {
    if (!isHost() || game.phase !== 'lobby') return;
    if (connectedPlayers().length < MIN_PLAYERS) return;
    const r = Number(opts && opts.rounds);
    startGame(ROUND_CHOICES.includes(r) ? r : 5);
  });

  socket.on('host:skip', () => {
    if (!isHost()) return;
    if (game.phase === 'writing') startVoting();
    else if (game.phase === 'voting') reveal();
  });

  socket.on('host:next', () => {
    if (!isHost() || game.phase !== 'reveal') return;
    if (game.round >= game.rounds) setPhase('final');
    else nextRound();
  });

  socket.on('host:lobby', () => {
    if (!isHost() || game.phase !== 'final') return;
    backToLobby();
  });

  // ----- الجوالات -----
  socket.on('player:join', (data, cb) => {
    const reply = ack(cb);
    const token = typeof data?.token === 'string' ? data.token.slice(0, 64) : '';
    const name = cleanText(data?.name, MAX_NAME);
    if (!token) return reply({ error: 'صار خطأ. حدّث الصفحة وجرّب مرة ثانية.' });
    if (!name) return reply({ error: 'اكتب اسمك.' });

    let p = game.players.get(tokens.get(token));
    const nameTaken = [...game.players.values()].some(
      (o) => o !== p && normalize(o.name) === normalize(name)
    );

    if (!p) {
      if (game.phase !== 'lobby') {
        return reply({ error: 'اللعبة بدأت. تقدر تدخل أول ما تبدأ لعبة جديدة.', retry: true });
      }
      if (game.players.size >= MAX_PLAYERS) return reply({ error: `اللعبة مليانة (${MAX_PLAYERS} لاعبين).` });
      if (nameTaken) return reply({ error: 'الاسم مأخوذ، اختر غيره.' });
      p = { id: crypto.randomBytes(6).toString('hex'), name, score: 0, connected: true, socketId: socket.id };
      game.players.set(p.id, p);
      tokens.set(token, p.id);
    } else {
      if (game.phase === 'lobby' && name !== p.name) {
        if (nameTaken) return reply({ error: 'الاسم مأخوذ، اختر غيره.' });
        p.name = name;
      }
      const old = p.socketId;
      p.socketId = socket.id;
      p.connected = true;
      if (old && old !== socket.id) io.sockets.sockets.get(old)?.disconnect(true);
    }
    socket.data.playerId = p.id;
    reply({ ok: true, name: p.name });
    broadcast();
  });

  socket.on('player:lie', (text, cb) => {
    const reply = ack(cb);
    const p = me();
    if (!p || game.phase !== 'writing') return reply({ error: 'انتهى وقت الكتابة.' });
    if (game.lies.has(p.id)) return reply({ error: 'أرسلت كذبتك خلاص.' });
    const lie = cleanText(text, MAX_LIE);
    if (!lie) return reply({ error: 'اكتب كذبتك أول.' });
    if (isTruth(lie)) return reply({ error: 'هذي الإجابة الصحيحة! اكتب كذبة بدالها.' });
    if ([...game.lies.values()].some((l) => normalize(l) === normalize(lie))) {
      return reply({ error: 'أحد سبقك بنفس الكذبة، جرّب غيرها.' });
    }
    game.lies.set(p.id, lie);
    reply({ ok: true });
    if (!checkProgress()) broadcast();
  });

  socket.on('player:vote', (optionId, cb) => {
    const reply = ack(cb);
    const p = me();
    if (!p || game.phase !== 'voting') return reply({ error: 'انتهى وقت التصويت.' });
    if (game.votes.has(p.id)) return reply({ error: 'صوّتت خلاص.' });
    const o = game.options.find((x) => x.id === optionId);
    if (!o) return reply({ error: 'هذا الاختيار مو موجود.' });
    if (o.authors.includes(p.id)) return reply({ error: 'ما تقدر تختار كذبتك.' });
    game.votes.set(p.id, o.id);
    reply({ ok: true });
    if (!checkProgress()) broadcast();
  });

  socket.on('disconnect', () => {
    const p = me();
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    if (!checkProgress()) broadcast();
  });
});

server.listen(PORT, () => {
  const ip = lanAddress();
  console.log(`الكذّاب شغالة على المنفذ ${PORT}`);
  console.log(`  الشاشة:   http://localhost:${PORT}/host`);
  if (ip) console.log(`  الجوالات: http://${ip}:${PORT}/  (لازم نفس الواي فاي)`);
});
