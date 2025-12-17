const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // allow small avatar images as data URLs
  maxHttpBufferSize: 2e6
});

app.use(express.static(path.join(__dirname, "public")));

const REQUIRED_KEYS = ["strength", "speed", "endurance", "defense", "intellect"];

// ----- validation -----
function validateStats(stats) {
  for (const k of REQUIRED_KEYS) {
    if (!(k in stats)) throw new Error(`Missing stat: ${k}`);
    const v = Number(stats[k]);
    if (!Number.isFinite(v)) throw new Error(`Stat '${k}' must be a number.`);
    if (v < 0 || v > 10) throw new Error(`Stat '${k}' must be 0–10.`);
  }
  const total = REQUIRED_KEYS.reduce((s, k) => s + Number(stats[k]), 0);
  if (Math.abs(total - 35) > 1e-9) throw new Error(`Total must be exactly 35 (got ${total}).`);
  const fixed = {};
  for (const k of REQUIRED_KEYS) fixed[k] = Number(stats[k]);
  return fixed;
}

function validateWeights(w) {
  for (const k of REQUIRED_KEYS) {
    const v = Number(w[k]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`Weight '${k}' must be > 0.`);
  }
  const fixed = {};
  for (const k of REQUIRED_KEYS) fixed[k] = Number(w[k]);
  return fixed;
}

// ----- RNG -----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUniform(rng, min, max) {
  return min + (max - min) * rng();
}

function randomWeights(rng) {
  const w = {};
  for (const k of REQUIRED_KEYS) w[k] = randomUniform(rng, 0.8, 1.2);
  return w;
}

function weightedChoice(rng, pair, probs) {
  const total = probs[0] + probs[1];
  if (total <= 0) return pair[Math.floor(rng() * pair.length)];
  const r = rng() * total;
  return r < probs[0] ? pair[0] : pair[1];
}

function score(stats, weights) {
  return REQUIRED_KEYS.reduce((s, k) => s + stats[k] * weights[k], 0);
}

function tiebreak(a, b) {
  const order = ["intellect", "speed", "strength", "defense", "endurance"];
  for (const k of order) {
    if (a[k] !== b[k]) return a[k] > b[k] ? "A" : "B";
  }
  return "Tie";
}

// ----- damage model (real per-round damage) -----
// Each round: pick a stat, compute weighted contest, winner deals damage.
// Damage = base + scale * (weighted_diff) + small randomness
// Also incorporate attacker strength slightly, defender defense slightly to feel "fighter-ish".
function computeDamage(rng, attacker, defender, stat, weights) {
  const w = weights[stat];
  const attStat = attacker.stats[stat];
  const defStat = defender.stats[stat];

  const weightedDiff = Math.max(0, (attStat - defStat) * w);

  const base = 6;                 // minimum-ish damage when you win
  const diffScale = 4.0;          // how much stat gap matters
  const attBonus = 0.35 * attacker.stats.strength;
  const defMitigate = 0.25 * defender.stats.defense;

  const jitter = randomUniform(rng, -1.2, 1.6);

  let dmg = base + diffScale * weightedDiff + attBonus - defMitigate + jitter;
  dmg = Math.max(3, Math.min(28, dmg)); // clamp so fights don't insta-end or drag forever
  return dmg;
}

function narrateRound(rng, a, b, weights, roundInfo) {
  const first = roundInfo.first;
  const stat = roundInfo.stat;
  const leader = roundInfo.leader;

  if (leader === "A") {
    return [
      `${first} charges in!`,
      `${a.name} unleashes ${a.ability}, overwhelming in ${stat} (x${weights[stat].toFixed(2)})!`,
      `${b.name} tries to resist with ${b.ability}, but takes ${roundInfo.damage.toFixed(0)} damage!`,
      `HP: ${a.name} ${roundInfo.hpA.toFixed(0)} — ${b.name} ${roundInfo.hpB.toFixed(0)}`,
      ""
    ].join("\n");
  } else {
    return [
      `${first} makes the first move!`,
      `${b.name} retaliates with ${b.ability}, dominating the ${stat} (x${weights[stat].toFixed(2)}) exchange!`,
      `${a.name} attempts ${a.ability}, but takes ${roundInfo.damage.toFixed(0)} damage!`,
      `HP: ${a.name} ${roundInfo.hpA.toFixed(0)} — ${b.name} ${roundInfo.hpB.toFixed(0)}`,
      ""
    ].join("\n");
  }
}

// ----- rooms + history -----
// roomCode -> room object
const rooms = new Map();

function newRoom() {
  const seed = Math.floor(Math.random() * 1e9);
  const rng = mulberry32(seed);
  return {
    sockets: { A: null, B: null },
    players: { A: null, B: null },
    seed,
    weights: randomWeights(rng),
    started: false,
    matchSeq: 0,
    history: [] // newest last
  };
}

function cleanRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  const hasA = room.sockets.A && io.sockets.sockets.get(room.sockets.A);
  const hasB = room.sockets.B && io.sockets.sockets.get(room.sockets.B);
  if (!hasA) { room.sockets.A = null; room.players.A = null; }
  if (!hasB) { room.sockets.B = null; room.players.B = null; }
  // room persists even if players leave (so spectators can keep viewing history)
  // but if nobody is connected, delete room
  const anyConnected = Array.from(io.sockets.sockets.values()).some(s => s.data?.roomCode === code);
  if (!anyConnected) rooms.delete(code);
}

function roomSnapshot(room) {
  return {
    weights: room.weights,
    seed: room.seed,
    started: room.started,
    players: {
      A: room.players.A ? { name: room.players.A.name, ability: room.players.A.ability, ready: !!room.players.A.ready } : null,
      B: room.players.B ? { name: room.players.B.name, ability: room.players.B.ability, ready: !!room.players.B.ready } : null
    },
    history: room.history.map(m => ({
      id: m.id,
      at: m.at,
      winner: m.result.tag,
      aName: m.fighters.A.name,
      bName: m.fighters.B.name
    }))
  };
}

function canControl(slot) {
  return slot === "A" || slot === "B";
}

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomCode }) => {
    roomCode = String(roomCode || "").trim().toUpperCase();
    if (!roomCode || roomCode.length > 10) {
      socket.emit("errorMsg", "Invalid room code.");
      return;
    }

    cleanRoom(roomCode);
    let room = rooms.get(roomCode);
    if (!room) {
      room = newRoom();
      rooms.set(roomCode, room);
    }

    // Assign A/B if free else Spectator
    let slot = null;
    if (!room.sockets.A) slot = "A";
    else if (!room.sockets.B) slot = "B";
    else slot = "SPECTATOR";

    socket.data.roomCode = roomCode;
    socket.data.slot = slot;

    if (slot === "A" || slot === "B") {
      room.sockets[slot] = socket.id;
    }

    socket.join(roomCode);

    socket.emit("joined", { roomCode, slot, snapshot: roomSnapshot(room) });
    io.to(roomCode).emit("roomUpdate", roomSnapshot(room));
  });

  socket.on("updatePlayer", (payload) => {
    const roomCode = socket.data.roomCode;
    const slot = socket.data.slot;
    if (!roomCode || !slot) return;
    if (!canControl(slot)) return; // spectators can't change fighters

    const room = rooms.get(roomCode);
    if (!room) return;

    try {
      const name = String(payload?.name || "").trim().slice(0, 32) || `Fighter ${slot}`;
      const ability = String(payload?.ability || "").trim().slice(0, 40) || "—";
      const avatar = payload?.avatarDataUrl && String(payload.avatarDataUrl).startsWith("data:image/")
        ? String(payload.avatarDataUrl).slice(0, 2_000_000)
        : null;

      const stats = validateStats(payload?.stats || {});
      const ready = !!payload?.ready;

      room.players[slot] = { name, ability, stats, avatar, ready };
      room.started = false;

      io.to(roomCode).emit("roomUpdate", roomSnapshot(room));

      const A = room.players.A, B = room.players.B;
      if (A?.ready && B?.ready) startFight(roomCode);
    } catch (e) {
      socket.emit("errorMsg", e.message || "Invalid input.");
    }
  });

  socket.on("setWeights", (payload) => {
    const roomCode = socket.data.roomCode;
    const slot = socket.data.slot;
    if (!roomCode) return;
    if (!canControl(slot)) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    try {
      room.weights = validateWeights(payload?.weights || {});
      room.started = false;
      io.to(roomCode).emit("roomUpdate", roomSnapshot(room));
    } catch (e) {
      socket.emit("errorMsg", e.message || "Invalid weights.");
    }
  });

  socket.on("requestHistory", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    socket.emit("historyUpdate", roomSnapshot(room).history);
  });

  socket.on("requestReplay", ({ matchId }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const match = room.history.find(m => m.id === matchId);
    if (!match) {
      socket.emit("errorMsg", "Replay not found.");
      return;
    }
    socket.emit("fightStart", match.payload);
  });

  socket.on("rematch", () => {
    const roomCode = socket.data.roomCode;
    const slot = socket.data.slot;
    if (!roomCode) return;
    if (!canControl(slot)) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Keep fighters/weights, new seed
    room.seed = Math.floor(Math.random() * 1e9);
    room.started = false;
    if (room.players.A) room.players.A.ready = true;
    if (room.players.B) room.players.B.ready = true;

    io.to(roomCode).emit("roomUpdate", roomSnapshot(room));
    const A = room.players.A, B = room.players.B;
    if (A?.ready && B?.ready) startFight(roomCode);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const slot = socket.data.slot;
    const room = rooms.get(roomCode);
    if (room && (slot === "A" || slot === "B") && room.sockets[slot] === socket.id) {
      room.sockets[slot] = null;
      room.players[slot] = null;
      room.started = false;
    }
    cleanRoom(roomCode);
    const still = rooms.get(roomCode);
    if (still) io.to(roomCode).emit("roomUpdate", roomSnapshot(still));
  });
});

function startFight(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.started) return;

  const A = room.players.A, B = room.players.B;
  if (!A?.ready || !B?.ready) return;

  room.started = true;

  const rng = mulberry32(room.seed);
  const a = { ...A, stats: A.stats };
  const b = { ...B, stats: B.stats };
  const w = room.weights;

  let hpA = 100;
  let hpB = 100;

  const rounds = [];

  for (let i = 0; i < 3; i++) {
    // initiative decides "first" for narration flavor
    const aInit = a.stats.speed * 0.6 + a.stats.intellect * 0.4;
    const bInit = b.stats.speed * 0.6 + b.stats.intellect * 0.4;
    const first = weightedChoice(rng, [a.name, b.name], [aInit, bInit]);

    const stat = REQUIRED_KEYS[Math.floor(rng() * REQUIRED_KEYS.length)];
    const aPower = a.stats[stat] * w[stat];
    const bPower = b.stats[stat] * w[stat];

    const leaderName = weightedChoice(rng, [a.name, b.name], [aPower, bPower]);
    const leader = leaderName === a.name ? "A" : "B";

    let damage = 0;
    if (leader === "A") {
      damage = computeDamage(rng, a, b, stat, w);
      hpB = Math.max(0, hpB - damage);
    } else {
      damage = computeDamage(rng, b, a, stat, w);
      hpA = Math.max(0, hpA - damage);
    }

    const roundInfo = { i, first, stat, leader, damage, hpA, hpB };
    rounds.push({
      ...roundInfo,
      narration: narrateRound(rng, a, b, w, roundInfo)
    });

    // end early if someone hits 0 HP
    if (hpA <= 0 || hpB <= 0) break;
  }

  // decide winner: if KO, winner is remaining; else score-based like original
  let tag;
  if (hpA <= 0 && hpB <= 0) tag = "Tie";
  else if (hpA <= 0) tag = "B";
  else if (hpB <= 0) tag = "A";
  else {
    const aS = score(a.stats, w);
    const bS = score(b.stats, w);
    if (Math.abs(aS - bS) < 1e-9) tag = tiebreak(a.stats, b.stats);
    else tag = aS > bS ? "A" : "B";
  }

  const aS = score(a.stats, w);
  const bS = score(b.stats, w);

  room.matchSeq += 1;
  const matchId = `${roomCode}-${room.matchSeq}`;

  const payload = {
    matchId,
    seed: room.seed,
    weights: w,
    fighters: {
      A: { name: a.name, ability: a.ability, stats: a.stats, avatar: a.avatar },
      B: { name: b.name, ability: b.ability, stats: b.stats, avatar: b.avatar }
    },
    rounds,
    finalHP: { A: hpA, B: hpB },
    result: { tag, aS, bS }
  };

  // store history (keep last 20)
  room.history.push({
    id: matchId,
    at: Date.now(),
    fighters: payload.fighters,
    result: payload.result,
    payload
  });
  if (room.history.length > 20) room.history.shift();

  io.to(roomCode).emit("roomUpdate", roomSnapshot(room));
  io.to(roomCode).emit("fightStart", payload);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Arena multiplayer+ running on http://localhost:${PORT}`);
});
