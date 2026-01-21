// public/app.js
window.APP_UTILS = window.APP_UTILS || {};

function $(id) { return document.getElementById(id); }
function safeText(s) { return (s ?? "").toString(); }

function shortAddr(a) {
  if (!a || typeof a !== "string" || a.length < 10) return a || "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtDate(tsSec) {
  if (!tsSec) return "—";
  const d = new Date(Number(tsSec) * 1000);
  return d.toLocaleString(undefined, { year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit" });
}

/** --------- time helpers --------- */
function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400); sec -= d * 86400;
  const h = Math.floor(sec / 3600);  sec -= h * 3600;
  const m = Math.floor(sec / 60);    sec -= m * 60;
  const s = sec;

  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (m || h || d) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function relativeLine(status, startSec, endSec) {
  const now = Math.floor(Date.now() / 1000);

  if (status === "Upcoming") {
    const toStart = startSec - now;
    const toEnd = endSec - now;
    return `Starts in ${fmtDuration(toStart)} • Ends in ${fmtDuration(toEnd)}`;
  }

  if (status === "Active") {
    const toEnd = endSec - now;
    return `Ends in ${fmtDuration(toEnd)}`;
  }

  if (status === "Ended") {
    const sinceEnd = now - endSec;
    return `Ended ${fmtDuration(sinceEnd)} ago`;
  }

  return "—";
}

function statusOf(now, p) {
  if (!p.exists) return "NotCreated";
  if (now < p.startTime) return "Upcoming";
  if (now > p.endTime) return "Ended";
  return "Active";
}

function badgeHTML(status) {
  const base = `display:inline-flex;align-items:center;gap:8px;padding:7px 10px;border-radius:999px;font-size:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);`;
  let dot = `width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.35);`;
  let text = status;

  if (status === "Active") { dot = `width:8px;height:8px;border-radius:50%;background:#7CFFB2;`; text = "Active"; }
  if (status === "Upcoming") { dot = `width:8px;height:8px;border-radius:50%;background:#f6d365;`; text = "Upcoming"; }
  if (status === "Ended") { dot = `width:8px;height:8px;border-radius:50%;background:#ff5c7a;`; text = "Ended"; }
  if (status === "NotCreated") { dot = `width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.25);`; text = "Not created"; }

  return `<span style="${base}"><span style="${dot}"></span><span>${text}</span></span>`;
}

async function loadPollsMeta() {
  const res = await fetch("/data/polls.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load /data/polls.json");
  const data = await res.json();
  return Array.isArray(data) ? data : (Array.isArray(data.polls) ? data.polls : []);
}

/** ---------- RPC picker (critical for Vercel prod) ---------- */
async function jsonRpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

async function pickWorkingRpc() {
  const cfg = window.ETHOS_CONFIG || {};
  const list = (cfg.rpcs && Array.isArray(cfg.rpcs) && cfg.rpcs.length)
    ? cfg.rpcs
    : [cfg.rpc || "https://mainnet.base.org"];

  const addr = cfg?.contracts?.EthosWeightedPoll?.address;
  if (!addr) throw new Error("Missing contract address in config.js");

  for (const url of list) {
    try {
      const chainIdHex = await jsonRpc(url, "eth_chainId", []);
      if (chainIdHex?.toLowerCase() !== "0x2105") continue; // 8453

      const code = await jsonRpc(url, "eth_getCode", [addr, "latest"]);
      if (code && code !== "0x") {
        return url;
      }
    } catch (_) {
      // try next
    }
  }

  throw new Error(`No working Base RPC found (contract code is 0x on all RPCs).`);
}

async function getReadProvider() {
  const rpc = await pickWorkingRpc();
  return { rpc, provider: new ethers.JsonRpcProvider(rpc) };
}

function getReadContract(provider) {
  const addr = window.ETHOS_CONFIG?.contracts?.EthosWeightedPoll?.address;
  if (!addr) throw new Error("Missing contract address in config.js");
  if (!window.ETHOS_POLL_ABI) throw new Error("Missing ETHOS_POLL_ABI (ethosPollAbi.js)");
  return new ethers.Contract(addr, window.ETHOS_POLL_ABI, provider);
}

// Simple concurrency limiter
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function enrichOnchain(pollsMeta) {
  const { rpc, provider } = await getReadProvider();
  const c = getReadContract(provider);
  const now = Math.floor(Date.now() / 1000);

  const enriched = await mapLimit(pollsMeta, 6, async (p) => {
    const pollIdBytes32 = ethers.id(p.id);
    let on = { exists:false, optionsCount:0, startTime:0, endTime:0, minScore:0 };

    try {
      const r = await c.polls(pollIdBytes32);
      on = {
        exists: Boolean(r[0]),
        optionsCount: Number(r[1]),
        startTime: Number(r[2]),
        endTime: Number(r[3]),
        minScore: Number(r[4]),
      };
    } catch (e) {
      // If a specific call fails, keep NotCreated for this poll
    }

    const status = statusOf(now, on);

    return { ...p, onchain: on, status, _rpc: rpc };
  });

  return enriched;
}

function renderFilters(state) {
  const mount = $("filtersMount");
  if (!mount) return;

  mount.innerHTML = `
    <div class="row" style="gap:10px; flex-wrap:wrap; margin: 8px 0 14px;">
      <span class="pill">Status:</span>
      <select id="filterStatus" class="pill" style="padding:10px 12px; border-radius:999px;">
        <option value="All">All</option>
        <option value="Active">Active</option>
        <option value="Upcoming">Upcoming</option>
        <option value="Ended">Ended</option>
      </select>

      <label class="pill" style="gap:10px; cursor:pointer;">
        <input id="showNotCreated" type="checkbox" style="transform:scale(1.1);" />
        Show not created
      </label>

      <button id="refreshBtn" class="btn secondary">Refresh</button>
    </div>
  `;

  $("filterStatus").value = state.filterStatus;
  $("showNotCreated").checked = state.showNotCreated;

  $("filterStatus").addEventListener("change", (e) => {
    state.filterStatus = e.target.value;
    renderAll(state);
  });

  $("showNotCreated").addEventListener("change", (e) => {
    state.showNotCreated = e.target.checked;
    renderAll(state);
  });

  $("refreshBtn").addEventListener("click", async () => {
    await loadAndRender(state, true);
  });
}

function applyFilters(polls, state) {
  return polls.filter(p => {
    if (!state.showNotCreated && p.status === "NotCreated") return false;
    if (state.filterStatus === "All") return true;
    return p.status === state.filterStatus;
  });
}

function pollCard(p) {
  const initiatorName = safeText(p?.initiator?.name || "Unknown");
  const pfp = safeText(p?.initiator?.pfp || "");
  const url = safeText(p?.initiator?.url || "");
  const minScore = Number(p?.onchain?.minScore || 0);
  const start = p?.onchain?.startTime || 0;
  const end = p?.onchain?.endTime || 0;

  const status = p.status;
  const badge = badgeHTML(status);

  const canVote = status === "Active";
  const canResults = status === "Ended";

  const voteHref = `/vote.html?id=${encodeURIComponent(p.id)}`;

  const actionHTML = canVote
    ? `<a class="btn primary" href="${voteHref}">Vote</a>`
    : canResults
      ? `<a class="btn secondary" href="${voteHref}">Results</a>`
      : `<a class="btn secondary" href="${voteHref}" style="opacity:.65; pointer-events:auto;">Details</a>`;

  const timeLine = p.onchain.exists
    ? relativeLine(status, start, end)
    : `Not created on-chain`;

  const minScoreLine = (p.onchain.exists)
    ? `<span class="pill small">minScore: ${minScore}</span>`
    : ``;

  const linkLine = url
    ? `<a class="pill small" href="${url}" target="_blank" rel="noreferrer">Initiator link</a>`
    : ``;

  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.innerHTML = `
    <div class="cardTop" style="align-items:flex-start;">
      <div class="pfp">${pfp ? `<img src="${pfp}" alt="" />` : ``}</div>
      <div class="cardMeta" style="gap:10px;">
        <div class="row" style="justify-content:space-between; gap:10px; align-items:flex-start;">
          <div style="min-width:0;">
            <div class="cardTitle">${safeText(p.question)}</div>
            <div class="cardSub">${initiatorName}</div>
          </div>
          <div>${badge}</div>
        </div>

        <div class="muted" style="font-size:12.5px; line-height:1.35;">
          ${timeLine}
        </div>

        <div class="row" style="gap:8px; flex-wrap:wrap;">
          <span class="pill small">${(p.options?.length || 0)} options</span>
          ${minScoreLine}
          ${linkLine}
        </div>

        <div class="row" style="gap:10px; flex-wrap:wrap; margin-top:2px;">
          ${actionHTML}
        </div>
      </div>
    </div>
  `;
  return wrap;
}

function renderAll(state) {
  const grid = $("pollGrid");
  const notice = $("notice");
  if (!grid || !notice) return;

  const filtered = applyFilters(state.polls, state);

  grid.innerHTML = "";
  for (const p of filtered) grid.appendChild(pollCard(p));

  const active = state.polls.filter(p => p.status === "Active").length;
  const upcoming = state.polls.filter(p => p.status === "Upcoming").length;
  const ended = state.polls.filter(p => p.status === "Ended").length;
  const totalStatus = active + upcoming + ended;

  notice.innerHTML = `
    <span class="muted">
      Total: ${totalStatus} • Active: ${active} • Upcoming: ${upcoming} • Ended: ${ended}
    </span>
  `;
}

function initAboutModal() {
  const btn = document.getElementById("aboutBtn");
  const modal = document.getElementById("aboutModal");
  const closeBtn = document.getElementById("aboutCloseBtn");
  const text = document.getElementById("aboutText");

  if (!btn || !modal || !closeBtn || !text) return;

  // ✅ ENGLISH TEXT
  text.innerHTML = `
    <div style="max-width:760px; line-height:1.45;">
      <p style="margin:0 0 10px;">
        <b>CredVote</b> is a platform where projects and individuals can post a question and collect feedback from verified web users.
        Verification is powered by <b>Ethos</b> — you can set any minimum Ethos Score requirement for your poll.
      </p>
  
      <div style="margin:12px 0 10px;">
        <div style="font-weight:700; margin:0 0 8px;">Voting power by Ethos Score</div>
  
        <div style="
          display:grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap:6px 18px;
          font-size:13px;
          opacity:.92;
        ">
          <div>0 → <b>1</b></div>
          <div>1800 → <b>5</b></div>
          <div>1200 → <b>2</b></div>
          <div>2000 → <b>6</b></div>
          <div>1400 → <b>3</b></div>
          <div>2200 → <b>7</b></div>
          <div>1600 → <b>4</b></div>
          <div>2400 → <b>8</b></div>
          <div>2600 → <b>9</b></div>
        </div>
      </div>
  
      <p style="margin:12px 0 10px;">
        <b>Why Ethos?</b> Strong moderation and a high barrier to entry — makes botting significantly harder.
      </p>
  
      <div style="margin:12px 0 8px; font-weight:800;">How it works</div>
      <ul style="margin:0 0 12px 18px; padding:0; line-height:1.45;">
        <li style="margin:6px 0;">
          Create a poll via the admin (DM
          <a href="https://x.com/Makssay_eth" target="_blank" rel="noreferrer">Makssay_eth</a>):
          question, options, min Ethos Score, time window.
        </li>
        <li style="margin:6px 0;">Users connect a wallet → we check their Ethos Score.</li>
        <li style="margin:6px 0;">If score ≥ min → they can vote, and the vote is weighted accordingly.</li>
        <li style="margin:6px 0;">After the poll ends → transparent results (votes, total weight, distribution).</li>
      </ul>
  
      <div style="margin:12px 0 8px; font-weight:800;">Why use this</div>
      <ul style="margin:0 0 0 18px; padding:0; line-height:1.45;">
        <li style="margin:6px 0;">Fast feedback from relevant people</li>
        <li style="margin:6px 0;">Harder to manipulate (costly entry + Ethos moderation)</li>
        <li style="margin:6px 0;">More honest outcomes with trust-weighted voting</li>
      </ul>
    </div>
  `;


  const open = () => { modal.style.display = "block"; };
  const close = () => { modal.style.display = "none"; };

  btn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  modal.style.display = "none";
}

async function loadAndRender(state, forceRefresh = false) {
  try {
    const notice = $("notice");
    if (notice) notice.textContent = forceRefresh ? "Refreshing on-chain status…" : "Loading polls…";

    const meta = await loadPollsMeta();
    const enriched = await enrichOnchain(meta);

    state.polls = enriched;
    renderAll(state);
  } catch (e) {
    const notice = $("notice");
    if (notice) notice.textContent = `Error: ${e?.message || e}`;
  }
}

// Wallet connect (label only)
async function connectWallet() {
  if (!window.ethereum) {
    alert("No wallet found. Install MetaMask/Rabby.");
    return;
  }
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const addr = await signer.getAddress();
  const label = $("walletLabel");
  if (label) label.textContent = `Connected: ${shortAddr(addr)}`;
}

window.APP_UTILS.connectWallet = connectWallet;

document.addEventListener("DOMContentLoaded", async () => {
  const state = {
    polls: [],
    filterStatus: "All",
    showNotCreated: false,
  };

  initAboutModal();
  renderFilters(state);
  await loadAndRender(state, false);

  setInterval(() => {
    if (state.polls && state.polls.length) renderAll(state);
  }, 1000);
});

