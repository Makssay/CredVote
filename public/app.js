window.APP_UTILS = window.APP_UTILS || {};
function $(id){ return document.getElementById(id); }
function safeText(s){ return (s ?? "").toString(); }

function shortAddr(a){
  if (!a || typeof a !== "string" || a.length < 10) return a || "";
  return `${a.slice(0,6)}…${a.slice(-4)}`;
}

function formatDelta(secondsAbs){
  let s = Math.floor(secondsAbs);
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hrs  = Math.floor(s / 3600);  s -= hrs  * 3600;
  const mins = Math.floor(s / 60);    s -= mins * 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hrs || days) parts.push(`${hrs}h`);
  if (mins || hrs || days) parts.push(`${mins}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function relativeLabel(nowSec, startSec, endSec, exists){
  if (!exists) return "Not created on-chain";
  if (nowSec < startSec) return `Starts in ${formatDelta(startSec - nowSec)}`;
  if (nowSec <= endSec) return `Ends in ${formatDelta(endSec - nowSec)}`;
  return `Ended ${formatDelta(nowSec - endSec)} ago`;
}

function statusOf(now, p){
  if (!p.exists) return "NotCreated";
  if (now < p.startTime) return "Upcoming";
  if (now > p.endTime) return "Ended";
  return "Active";
}

function badge(status){
  let cls = "dot";
  let label = status;
  if (status === "Active"){ cls = "dot ok"; label = "Active"; }
  if (status === "Upcoming"){ cls = "dot warn"; label = "Upcoming"; }
  if (status === "Ended"){ cls = "dot bad"; label = "Ended"; }
  if (status === "NotCreated"){ cls = "dot"; label = "Not created"; }
  return `<span class="badge"><span class="${cls}"></span><span>${label}</span></span>`;
}

async function loadPollsMeta(){
  const res = await fetch("/data/polls.json", { cache:"no-store" });
  if (!res.ok) throw new Error("Failed to load /data/polls.json");
  const data = await res.json();
  return Array.isArray(data) ? data : (Array.isArray(data.polls) ? data.polls : []);
}

function rpcCandidates(){
  const cfg = window.ETHOS_CONFIG || {};
  const list = Array.isArray(cfg.rpcs) ? cfg.rpcs : [];
  const single = cfg.rpc ? [cfg.rpc] : [];
  return [...new Set([...list, ...single].filter(Boolean))];
}

async function getReadProviderCandidates() {
  const wanted = BigInt(window.ETHOS_CONFIG?.chain?.chainId || 8453);

  // 1) Если кошелёк на Base — можно читать через него, но всё равно проверим код ниже
  if (window.ethereum) {
    try {
      const bp = new ethers.BrowserProvider(window.ethereum);
      const net = await bp.getNetwork();
      if (net?.chainId === wanted) return [{ type: "wallet", provider: bp }];
    } catch (_) {}
  }

  // 2) RPC фолбэки
  const cfg = window.ETHOS_CONFIG || {};
  const list = Array.isArray(cfg.rpcs) ? cfg.rpcs : [];
  const single = cfg.rpc ? [cfg.rpc] : [];
  const urls = [...new Set([...list, ...single].filter(Boolean))];

  return urls.map((url) => ({ type: "rpc", url, provider: new ethers.JsonRpcProvider(url) }));
}

async function getReadProvider() {
  const wanted = BigInt(window.ETHOS_CONFIG?.chain?.chainId || 8453);
  const addr = window.ETHOS_CONFIG?.contracts?.EthosWeightedPoll?.address;
  if (!addr) throw new Error("Missing contract address in config.js");

  const cands = await getReadProviderCandidates();
  let lastErr = null;

  for (const cand of cands) {
    try {
      const p = cand.provider;

      // проверка сети
      const net = await p.getNetwork();
      if (net?.chainId !== wanted) throw new Error(`RPC not Base (got ${net?.chainId})`);

      // проверка живости
      await p.getBlockNumber();

      // КЛЮЧЕВОЕ: проверяем, что этот RPC реально видит код контракта
      const code = await p.getCode(addr);
      if (!code || code === "0x") {
        throw new Error(`No contract code via ${cand.type === "rpc" ? cand.url : "wallet provider"}`);
      }

      return p; 
    } catch (e) {
      lastErr = e;
      // пробуем следующий RPC
    }
  }

  throw new Error(`All RPC endpoints failed. Last error: ${lastErr?.message || lastErr}`);
}

async function getReadContract() {
  const addr = window.ETHOS_CONFIG?.contracts?.EthosWeightedPoll?.address;
  if (!addr) throw new Error("Missing contract address in config.js");
  if (!window.ETHOS_POLL_ABI) throw new Error("Missing ETHOS_POLL_ABI (ethosPollAbi.js)");

  const provider = await getReadProvider();
  return new ethers.Contract(addr, window.ETHOS_POLL_ABI, provider);
}


async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let i = 0;
  async function worker(){
    while(true){
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function enrichOnchain(meta){
  const c = await getReadContract();
  const now = Math.floor(Date.now()/1000);

  return await mapLimit(meta, 6, async (p) => {
    const id32 = ethers.id(String(p.id));
    let on = { exists:false, optionsCount:0, startTime:0, endTime:0, minScore:0 };
    try{
      const r = await c.polls(id32);
      on = {
        exists: Boolean(r[0]),
        optionsCount: Number(r[1]),
        startTime: Number(r[2]),
        endTime: Number(r[3]),
        minScore: Number(r[4]),
      };
    }catch(_){}

    return { ...p, onchain: on, status: statusOf(now, on), _id32: id32, _totalVotes: null };
  });
}

async function computeTotalVotesForPoll(c, poll){
  if (!poll?.onchain?.exists) return 0n;
  const n = Number(poll.onchain.optionsCount || poll.options?.length || 0);
  if (!n) return 0n;
  const calls = [];
  for (let i=0;i<n;i++) calls.push(c.tally(poll._id32, i));
  const res = await Promise.all(calls);
  let sum = 0n;
  for (const x of res) sum += BigInt(x);
  return sum;
}

function applyStatusFilter(items, filterStatus){
  if (filterStatus === "All") return items.filter(p => p.status !== "NotCreated");
  if (filterStatus === "ActiveUpcoming") return items.filter(p => (p.status === "Active" || p.status === "Upcoming"));
  if (filterStatus === "Active") return items.filter(p => p.status === "Active");
  if (filterStatus === "Upcoming") return items.filter(p => p.status === "Upcoming");
  if (filterStatus === "Ended") return items.filter(p => p.status === "Ended");
  return items;
}

function sortPolls(items, sortBy){
  const bySoonEnding = (a,b) => {
    const rank = (p) => {
      if (p.status === "Active") return 0;
      if (p.status === "Upcoming") return 1;
      if (p.status === "Ended") return 2;
      return 3;
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;

    const ta = (a.status === "Upcoming") ? (a.onchain.startTime || 0) : (a.onchain.endTime || 0);
    const tb = (b.status === "Upcoming") ? (b.onchain.startTime || 0) : (b.onchain.endTime || 0);
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  };

  const byNew = (a,b) => {
    const sa = Number(a.onchain.startTime || 0);
    const sb = Number(b.onchain.startTime || 0);
    if (sa !== sb) return sb - sa;
    const ea = Number(a.onchain.endTime || 0);
    const eb = Number(b.onchain.endTime || 0);
    if (ea !== eb) return eb - ea;
    return String(a.id).localeCompare(String(b.id));
  };

  const byVotes = (a,b) => {
    const va = (a._totalVotes == null) ? -1n : BigInt(a._totalVotes);
    const vb = (b._totalVotes == null) ? -1n : BigInt(b._totalVotes);
    if (va !== vb) return (vb > va) ? 1 : -1;
    return bySoonEnding(a,b);
  };

  const arr = [...items];
  if (sortBy === "new") arr.sort(byNew);
  else if (sortBy === "votes") arr.sort(byVotes);
  else arr.sort(bySoonEnding);

  return arr;
}

function pollCard(p){
  const initiatorName = safeText(p?.initiator?.name || "Unknown");
  const pfp = safeText(p?.initiator?.pfp || "");
  const question = safeText(p?.question || p?.id);

  const now = Math.floor(Date.now()/1000);
  const rel = relativeLabel(now, p.onchain.startTime, p.onchain.endTime, p.onchain.exists);

  const minScore = Number(p?.onchain?.minScore || 0);
  const voteHref = `/vote.html?id=${encodeURIComponent(p.id)}`;

  const votesPill = (p._totalVotes != null)
    ? `<span class="pill small">Votes: ${BigInt(p._totalVotes).toString()}</span>`
    : ``;

  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:flex-start;">
      <div class="cardTop">
        <div class="pfp">${pfp ? `<img src="${pfp}" alt="" />` : ``}</div>
        <div class="cardMeta">
          <div class="cardTitle">${question}</div>
          <div class="cardSub">${initiatorName}</div>
        </div>
      </div>
      <div>${badge(p.status)}</div>
    </div>

    <div class="sepLine"></div>

    <div class="row" style="flex-wrap:wrap; justify-content:space-between;">
      <div class="muted">${rel}</div>
    </div>

    <div class="row" style="margin-top:10px; flex-wrap:wrap;">
      ${p.onchain.exists ? `<span class="pill small">Min Ethos score: ${minScore}</span>` : ``}
      ${votesPill}
    </div>

    <div class="row" style="margin-top:12px; justify-content:flex-end;">
      <a class="btn primary" href="${voteHref}" style="${p.status !== "Active" ? "opacity:.65;" : ""}">Vote</a>
    </div>
  `;
  return el;
}

function render(state){
  const grid = $("pollGrid");
  const note = $("notice");
  if (!grid || !note) return;

  const filtered = applyStatusFilter(state.polls, state.filterStatus);
  const sorted = sortPolls(filtered, state.sortBy);

  grid.innerHTML = "";
  for (const p of sorted) grid.appendChild(pollCard(p));

  const active = state.polls.filter(p => p.status === "Active").length;
  const upcoming = state.polls.filter(p => p.status === "Upcoming").length;
  const ended = state.polls.filter(p => p.status === "Ended").length;
  const total = active + upcoming + ended; // только созданные on-chain

  note.textContent = `Total: ${total} • Active: ${active} • Upcoming: ${upcoming} • Ended: ${ended}`;
}

async function maybeLoadVotesTotals(state){
  if (state.sortBy !== "votes") return;
  const c = await getReadContract();

  const candidates = state.polls.filter(p => p.onchain?.exists && p._totalVotes == null);
  if (!candidates.length) return;

  $("notice").textContent = "Loading vote totals…";

  await mapLimit(candidates, 3, async (p) => {
    p._totalVotes = await computeTotalVotesForPoll(c, p);
  });
}

async function loadAndRender(state, refresh=false){
  try{
    $("notice").textContent = refresh ? "Refreshing…" : "Loading…";
    const meta = await loadPollsMeta();
    const enriched = await enrichOnchain(meta);
    state.polls = enriched;

    await maybeLoadVotesTotals(state);
    render(state);
  }catch(e){
    $("notice").textContent = `RPC/Chain error: ${e?.shortMessage || e?.message || e}`;
  }
}

async function connectWallet(){
  if (!window.ethereum) return alert("No wallet found. Install MetaMask/Rabby.");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const addr = await signer.getAddress();
  $("walletLabel").textContent = `Connected: ${shortAddr(addr)}`;
}
window.APP_UTILS.connectWallet = connectWallet;

/* About modal */
function aboutText(){
  return [
    "Hello from CredVote! This is a platform where projects and people can post a question and get opinions from verified web users.",
    "",
    "To verify users we use Ethos. You can choose any minimum Ethos score requirement for your poll.",
    "Users with different scores have different voting power:",
    "0 = 1",
    "1200 = 2",
    "1400 = 3",
    "1600 = 4",
    "1800 = 5",
    "2000 = 6",
    "2200 = 7",
    "2400 = 8",
    "2600 = 9",
    "",
    "Why Ethos?",
    "Strong moderation and a high barrier to entry, which significantly reduces the chance of bot manipulation.",
    "",
    "# How it works:",
    "You create a poll via the admin (DM: https://x.com/Makssay_eth): question, options, min Ethos score, time window.",
    "",
    "A user connects a wallet → we check their Ethos score.",
    "If score ≥ min → they can vote, and their vote is counted with the correct weight.",
    "",
    "After the poll ends you get transparent results: number of votes, total weight, and distribution across options.",
    "",
    "# Why this helps",
    "• Quickly collect feedback from relevant people",
    "• Harder to manipulate (expensive entry + Ethos moderation)",
    "• Fairer results thanks to “trust weight”, not just clicks"
  ].join("\n");
}

function setupAboutModal(){
  const modal = $("aboutModal");
  const openBtn = $("aboutBtn");
  const closeBtn = $("aboutCloseBtn");
  const text = $("aboutText");
  if (!modal || !openBtn || !closeBtn || !text) return;

  text.textContent = aboutText();

  function open(){
    modal.classList.add("show");
    document.body.style.overflow = "hidden";
  }
  function close(){
    modal.classList.remove("show");
    document.body.style.overflow = "";
  }

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

document.addEventListener("DOMContentLoaded", async () => {
  const state = { polls: [], filterStatus: "ActiveUpcoming", sortBy: "ending" };

  if ($("filterStatus")) $("filterStatus").value = state.filterStatus;
  if ($("sortBy")) $("sortBy").value = state.sortBy;

  $("filterStatus")?.addEventListener("change", (e) => { state.filterStatus = e.target.value; render(state); });
  $("sortBy")?.addEventListener("change", async (e) => { state.sortBy = e.target.value; await maybeLoadVotesTotals(state); render(state); });
  $("refreshBtn")?.addEventListener("click", async () => { await loadAndRender(state, true); });

  setupAboutModal();

  await loadAndRender(state, false);

  setInterval(() => render(state), 1000);
});

