const socket = io();

const REQUIRED_KEYS = ["strength", "speed", "endurance", "defense", "intellect"];

const DEFAULTS = {
  A: { name:"Blaze Titan", ability:"Inferno Strike", stats:{strength:9,speed:8,endurance:7,defense:6,intellect:5} },
  B: { name:"Frost Fang", ability:"Glacial Storm", stats:{strength:7,speed:7,endurance:9,defense:8,intellect:4} }
};

let slot = null;          // "A" | "B" | "SPECTATOR"
let roomCode = null;
let ready = false;
let avatarDataUrl = null;
let latestSnapshot = null;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  setTimeout(()=>t.classList.remove("on"), 1600);
}

function isController(){
  return slot === "A" || slot === "B";
}

function setControlsEnabled(enabled){
  const ids = ["avatarFile","clearAvatar","name","ability","strength","speed","endurance","defense","intellect","readyBtn","saveWeights","rematchBtn"];
  for (const id of ids){
    const el = $(id);
    if (!el) continue;
    el.disabled = !enabled;
  }
  $("uploadBtnWrap").style.pointerEvents = enabled ? "auto" : "none";
  $("uploadBtnWrap").style.opacity = enabled ? "1" : "0.45";
  $("spectatorBanner").style.display = enabled ? "none" : "block";
}

function sumStats() {
  let total = 0;
  for (const k of REQUIRED_KEYS) {
    const v = Number($(k).value);
    total += Number.isFinite(v) ? v : 0;
  }
  return total;
}

function updateTotalUI() {
  const total = sumStats();
  const el = $("total");
  el.textContent = `Total: ${total.toFixed(2)} / 35`;
  el.classList.remove("good","bad");
  el.classList.add(Math.abs(total-35)<1e-9 ? "good" : "bad");
}

function getPlayerPayload(){
  const name = ($("name").value || "").trim();
  const ability = ($("ability").value || "").trim();
  const stats = {};
  for (const k of REQUIRED_KEYS) stats[k] = Number($(k).value);
  return { name, ability, stats, ready, avatarDataUrl };
}

function setWeightsUI(w){
  for (const k of REQUIRED_KEYS) $(`w_${k}`).value = Number(w[k]).toFixed(3);
}

function getWeightsUI(){
  const w = {};
  for (const k of REQUIRED_KEYS) w[k] = Number($(`w_${k}`).value);
  return w;
}

function applyAvatarPreview() {
  const img = $("avatarImg");
  const fb = $("avatarFallback");
  if (avatarDataUrl) {
    img.src = avatarDataUrl;
    img.style.display = "block";
    fb.style.display = "none";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
    fb.style.display = "flex";
  }
}

function setFightFighter(which, fighter){
  $(`n${which}`).textContent = fighter?.name || which;
  const img = $(`img${which}`);
  const fb = $(`fb${which}`);

  if (fighter?.avatar) {
    img.src = fighter.avatar;
    img.style.display = "block";
    fb.style.display = "none";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
    fb.style.display = "flex";
  }
}

function addFlashAndSparks(){
  const fx = $("fx");
  fx.innerHTML = "";

  const flash = document.createElement("div");
  flash.className = "flash";
  fx.appendChild(flash);

  for (let i=0;i<14;i++){
    const s = document.createElement("div");
    s.className = "spark";
    const ang = Math.random()*Math.PI*2;
    const dist = 40 + Math.random()*160;
    s.style.setProperty("--dx", `${Math.cos(ang)*dist}px`);
    s.style.setProperty("--dy", `${Math.sin(ang)*dist}px`);
    fx.appendChild(s);
  }

  setTimeout(()=>fx.innerHTML="", 550);
}

function shakeArena(){
  const arena = document.querySelector(".arena");
  arena.classList.add("shake");
  setTimeout(()=>arena.classList.remove("shake"), 260);
}

function setHP(aPct,bPct){
  $("hpA").style.width = `${Math.max(0,Math.min(100,aPct))}%`;
  $("hpB").style.width = `${Math.max(0,Math.min(100,bPct))}%`;
}

function makeScoreTable(A,B,res,weights,finalHP){
  const rows = REQUIRED_KEYS.map(k=>{
    const K = k[0].toUpperCase()+k.slice(1);
    return `<tr>
      <td><b>${K}</b></td>
      <td>${A.name}: ${A.stats[k].toFixed(1)}</td>
      <td>${B.name}: ${B.stats[k].toFixed(1)}</td>
      <td>${weights[k].toFixed(2)}</td>
    </tr>`;
  }).join("");

  return `<table>
    <thead><tr><th>Stat</th><th>Fighter A</th><th>Fighter B</th><th>Weight</th></tr></thead>
    <tbody>
      ${rows}
      <tr>
        <td><b>Total Score</b></td>
        <td colspan="3">${A.name}: <b>${res.aS.toFixed(2)}</b> vs ${B.name}: <b>${res.bS.toFixed(2)}</b></td>
      </tr>
      <tr>
        <td><b>Final HP</b></td>
        <td colspan="3">${A.name}: <b>${finalHP.A.toFixed(0)}</b> — ${B.name}: <b>${finalHP.B.toFixed(0)}</b></td>
      </tr>
    </tbody>
  </table>`;
}

function renderHistory(list){
  const wrap = $("historyList");
  if (!list || list.length === 0){
    wrap.textContent = "No matches yet.";
    return;
  }
  wrap.innerHTML = "";
  // newest first
  const items = [...list].sort((a,b)=>b.at-a.at);

  for (const m of items){
    const when = new Date(m.at).toLocaleString();
    const winner = m.winner === "Tie" ? "Tie" : (m.winner === "A" ? "A wins" : "B wins");

    const row = document.createElement("div");
    row.className = "historyItem";

    const meta = document.createElement("div");
    meta.className = "historyMeta";
    meta.innerHTML = `<div><b>${m.aName}</b> vs <b>${m.bName}</b> — <b>${winner}</b></div><div class="small">${m.id} • ${when}</div>`;

    const btn = document.createElement("button");
    btn.className = "btn small ghost";
    btn.textContent = "Replay";
    btn.onclick = () => {
      if (!roomCode) return toast("Join a room first.");
      socket.emit("requestReplay", { matchId: m.id });
    };

    row.appendChild(meta);
    row.appendChild(btn);
    wrap.appendChild(row);
  }
}

function renderRoomStatus(snapshot){
  latestSnapshot = snapshot;
  const A = snapshot.players.A;
  const B = snapshot.players.B;

  const aReady = A?.ready ? "✅ READY" : "⏳ not ready";
  const bReady = B?.ready ? "✅ READY" : "⏳ not ready";

  $("status").textContent =
    `Player A: ${A ? A.name : "(empty)"} ${A ? "— " + aReady : ""}\n` +
    `Player B: ${B ? B.name : "(empty)"} ${B ? "— " + bReady : ""}\n` +
    (snapshot.started ? "\nFight started!" : "\nWaiting for both players to be READY.");

  if (snapshot.weights) setWeightsUI(snapshot.weights);
  if (snapshot.history) renderHistory(snapshot.history);
}

async function readFileAsDataURL(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ===== Socket events =====
socket.on("joined", ({ roomCode: rc, slot: sl, snapshot }) => {
  roomCode = rc;
  slot = sl;

  $("roomLabel").textContent = roomCode;
  $("slotLabel").textContent = slot;

  // enable/disable controls based on role
  setControlsEnabled(isController());

  if (isController()){
    // load defaults based on slot
    const d = DEFAULTS[slot] || DEFAULTS.A;
    $("name").value = d.name;
    $("ability").value = d.ability;
    for (const k of REQUIRED_KEYS) $(k).value = d.stats[k];

    avatarDataUrl = null;
    applyAvatarPreview();

    ready = false;
    $("readyBtn").textContent = "READY";
    updateTotalUI();

    // push initial state
    socket.emit("updatePlayer", getPlayerPayload());
  } else {
    // spectator: clear local inputs
    $("name").value = "";
    $("ability").value = "";
    for (const k of REQUIRED_KEYS) $(k).value = "";
    avatarDataUrl = null;
    applyAvatarPreview();
    ready = false;
    $("readyBtn").textContent = "READY";
    updateTotalUI();
  }

  renderRoomStatus(snapshot);
  toast(`Joined room ${roomCode} as ${slot}`);

  // ask for history explicitly (also sent in snapshots)
  socket.emit("requestHistory");
});

socket.on("roomUpdate", (snapshot) => {
  renderRoomStatus(snapshot);
});

socket.on("historyUpdate", (list) => {
  renderHistory(list);
});

socket.on("fightStart", async (payload) => {
  const logEl = $("log");
  logEl.textContent = "";
  $("scoreWrap").innerHTML = "";
  $("winner").textContent = "";
  $("matchLabel").textContent = payload.matchId || "—";

  const A = payload.fighters.A;
  const B = payload.fighters.B;

  setFightFighter("A", A);
  setFightFighter("B", B);
  setHP(100,100);

  logEl.textContent += `--- Arena Intro (Match ${payload.matchId}) ---\n`;
  logEl.textContent += `${A.name} enters the arena, channeling: ${A.ability}!\n`;
  logEl.textContent += `${B.name} steps forward, unleashing: ${B.ability}!\n`;
  logEl.textContent += "-------------------\n\n";

  // animate rounds exactly as server computed (including HP)
  for (let i=0;i<payload.rounds.length;i++){
    const r = payload.rounds[i];

    addFlashAndSparks();
    shakeArena();

    // HP after this round
    setHP(r.hpA, r.hpB);

    logEl.textContent += r.narration + "\n";
    logEl.scrollTop = logEl.scrollHeight;
    await sleep(750);
  }

  $("scoreWrap").innerHTML = makeScoreTable(A,B,payload.result,payload.weights,payload.finalHP);

  if (payload.result.tag === "Tie") $("winner").textContent = "It’s a tie! The crowd demands a rematch!";
  else if (payload.result.tag === "A") $("winner").textContent = `🏆 ${A.name} wins!`;
  else $("winner").textContent = `🏆 ${B.name} wins!`;

  addFlashAndSparks();
  shakeArena();
});

socket.on("errorMsg", (msg) => toast(msg));

// ===== UI wiring =====
$("joinBtn").addEventListener("click", () => {
  const code = ($("roomCode").value || "").trim().toUpperCase();
  if (!code) return toast("Enter a room code.");
  socket.emit("joinRoom", { roomCode: code });
});

for (const k of REQUIRED_KEYS) {
  $(k).addEventListener("input", () => {
    updateTotalUI();
    if (roomCode && isController()) socket.emit("updatePlayer", getPlayerPayload());
  });
}

$("name").addEventListener("input", () => roomCode && isController() && socket.emit("updatePlayer", getPlayerPayload()));
$("ability").addEventListener("input", () => roomCode && isController() && socket.emit("updatePlayer", getPlayerPayload()));

$("readyBtn").addEventListener("click", () => {
  if (!roomCode) return toast("Join a room first.");
  if (!isController()) return toast("Spectators can’t ready up.");
  ready = !ready;
  $("readyBtn").textContent = ready ? "READY ✓" : "READY";
  socket.emit("updatePlayer", getPlayerPayload());
});

$("saveWeights").addEventListener("click", () => {
  if (!roomCode) return toast("Join a room first.");
  if (!isController()) return toast("Spectators can’t change weights.");
  socket.emit("setWeights", { weights: getWeightsUI() });
  toast("Weights sent to room.");
});

$("rematchBtn").addEventListener("click", () => {
  if (!roomCode) return toast("Join a room first.");
  if (!isController()) return toast("Spectators can’t start rematches.");
  socket.emit("rematch");
});

$("refreshHistory").addEventListener("click", () => {
  if (!roomCode) return toast("Join a room first.");
  socket.emit("requestHistory");
});

// avatar upload
$("avatarFile").addEventListener("change", async (e) => {
  if (!isController()) return;
  const file = e.target.files?.[0];
  if (!file) return;

  if (file.size > 600_000) toast("That image is big — consider a smaller one.");

  avatarDataUrl = await readFileAsDataURL(file);
  applyAvatarPreview();
  if (roomCode) socket.emit("updatePlayer", getPlayerPayload());
});

$("clearAvatar").addEventListener("click", () => {
  if (!isController()) return;
  avatarDataUrl = null;
  applyAvatarPreview();
  if (roomCode) socket.emit("updatePlayer", getPlayerPayload());
});

// init
updateTotalUI();
applyAvatarPreview();
