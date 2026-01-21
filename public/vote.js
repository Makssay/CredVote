window.VOTE_UTILS = window.VOTE_UTILS || {};
function qs(name){ return new URLSearchParams(location.search).get(name); }
function safeText(s){ return (s ?? "").toString(); }

function setStatus(msg, isError=false){
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? "tomato" : "";
}

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

async function getReadProvider(){
  const wanted = BigInt(window.ETHOS_CONFIG?.chain?.chainId || 8453);

  if (window.ethereum){
    const bp = new ethers.BrowserProvider(window.ethereum);
    const net = await bp.getNetwork();
    if (net?.chainId === wanted) return bp;
  }

  let lastErr = null;
  for (const url of rpcCandidates()){
    try{
      const p = new ethers.JsonRpcProvider(url);
      const net = await p.getNetwork();
      if (net?.chainId !== wanted) throw new Error(`RPC not Base (got ${net?.chainId})`);
      return p;
    }catch(e){ lastErr = e; }
  }
  throw new Error(`All RPC endpoints failed. Last error: ${lastErr?.message || lastErr}`);
}

async function getReadContract(){
  const addr = window.ETHOS_CONFIG?.contracts?.EthosWeightedPoll?.address;
  const provider = await getReadProvider();
  const code = await provider.getCode(addr);
  if (!code || code === "0x") throw new Error(`No contract code at ${addr}. Check address/RPC.`);
  return new ethers.Contract(addr, window.ETHOS_POLL_ABI, provider);
}

async function getWriteContract(){
  if (!window.ethereum) throw new Error("No wallet found");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const net = await provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error("Switch wallet to Base Mainnet");
  const signer = await provider.getSigner();
  const addr = window.ETHOS_CONFIG.contracts.EthosWeightedPoll.address;
  return { contract: new ethers.Contract(addr, window.ETHOS_POLL_ABI, signer), signer };
}

function computeStatus(now, on){
  if (!on.exists) return "Not created";
  if (now < on.startTime) return "Upcoming";
  if (now > on.endTime) return "Ended";
  return "Active";
}

function setButtonsEnabled(enabled){
  const wrap = document.getElementById("options");
  if (!wrap) return;
  [...wrap.querySelectorAll("button")].forEach(btn => {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : ".6";
    btn.style.cursor = enabled ? "pointer" : "not-allowed";
  });
}

async function connectWallet(){
  const { signer } = await getWriteContract();
  const addr = await signer.getAddress();
  document.getElementById("walletLabel").textContent = `Connected: ${shortAddr(addr)}`;
  window.__VOTE_STATE.wallet = { addr };
  await refreshEligibilityAndVoted();
}
window.VOTE_UTILS.connectWallet = connectWallet;

async function readOnchainPoll(c, pollIdStr){
  const id32 = ethers.id(String(pollIdStr));
  const r = await c.polls(id32);
  return {
    id32,
    exists: Boolean(r[0]),
    optionsCount: Number(r[1]),
    startTime: Number(r[2]),
    endTime: Number(r[3]),
    minScore: Number(r[4]),
  };
}

async function readTallies(c, id32, optionsCount){
  const calls = [];
  for (let i=0;i<optionsCount;i++) calls.push(c.tally(id32, i));
  const out = await Promise.all(calls);
  return out.map(x => BigInt(x));
}

function renderResults(meta, tallies){
  const box = document.getElementById("resultsBox");
  const total = tallies.reduce((a,b)=>a+BigInt(b), 0n);

  const rows = tallies.map((v, i) => {
    const vv = BigInt(v);
    const pct = total > 0n ? Number((vv * 10000n) / total)/100 : 0;
    const label = safeText(meta.options?.[i] ?? `Option ${i}`);
    return { label, vv: vv.toString(), pct };
  });

  box.innerHTML = rows.map(r => `
    <div style="margin-bottom:12px;">
      <div class="row" style="justify-content:space-between; gap:10px;">
        <div style="font-weight:700;">${r.label}</div>
        <div class="muted">${r.vv} • ${r.pct.toFixed(2)}%</div>
      </div>
      <div class="barWrap" style="margin-top:8px;">
        <div class="bar" style="width:${Math.min(100, Math.max(0, r.pct))}%"></div>
      </div>
    </div>
  `).join("") + `
    <div class="row" style="justify-content:flex-end;">
      <span class="pill small">Total weight: ${total.toString()}</span>
    </div>
  `;
}

async function refreshResults(){
  const st = window.__VOTE_STATE;
  try{
    const c = await getReadContract();
    const tallies = await readTallies(c, st.onchain.id32, st.onchain.optionsCount);
    renderResults(st.meta, tallies);
  }catch(_){}
}

async function refreshEligibilityAndVoted(){
  const st = window.__VOTE_STATE;
  const eligLine = document.getElementById("eligLine");
  const votedLine = document.getElementById("votedLine");

  if (!st.wallet?.addr){
    setButtonsEnabled(false);
    eligLine.textContent = "Eligibility: connect wallet";
    votedLine.textContent = "";
    return;
  }

  try{
    const r = await fetch(`/api/eligibility?pollId=${encodeURIComponent(st.pollId)}&address=${encodeURIComponent(st.wallet.addr)}`, { cache:"no-store" });
    const j = await r.json();
    if (j?.error) throw new Error(j.error);

    st.elig = j;

    const eligible = Boolean(j.eligible);
    const score = j?.ethos?.score;
    const weight = j?.weight;

    eligLine.textContent = eligible
      ? `Eligible ✅ Ethos score=${score} → weight=${weight}`
      : `Not eligible ❌ Ethos score=${score}, min=${j.minScore}`;
    eligLine.style.color = eligible ? "" : "tomato";

    const c = await getReadContract();
    const hv = await c.hasVoted(st.onchain.id32, st.wallet.addr);
    st.hasVoted = Boolean(hv);

    votedLine.textContent = st.hasVoted ? "You already voted ✅" : "You have not voted yet.";

    const now = Math.floor(Date.now()/1000);
    const s = computeStatus(now, st.onchain);
    const canVote = (s === "Active") && eligible && !st.hasVoted;

    setButtonsEnabled(canVote);
  }catch(e){
    eligLine.textContent = `Eligibility error: ${e?.message || e}`;
    eligLine.style.color = "tomato";
    setButtonsEnabled(false);
  }
}

async function vote(optionId){
  const st = window.__VOTE_STATE;
  try{
    if (!st.wallet?.addr) await connectWallet();

    await refreshEligibilityAndVoted();
    if (!st.elig?.eligible) throw new Error("Not eligible");
    if (st.hasVoted) throw new Error("Already voted");

    const now = Math.floor(Date.now()/1000);
    if (computeStatus(now, st.onchain) !== "Active") throw new Error("Poll not active");

    setStatus("Requesting oracle signature…");

    const resp = await fetch("/api/sign-vote", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ pollId: st.pollId, optionId, voter: st.wallet.addr }),
    });

    const j = await resp.json();
    if (!resp.ok) throw new Error(j?.error || "sign-vote failed");

    const weight = BigInt(j.weight);
    const deadline = BigInt(j.deadline);
    const signature = j.signature;

    setStatus(`Sending tx… weight=${weight.toString()}`);

    const { contract } = await getWriteContract();
    const tx = await contract.castVote(st.onchain.id32, Number(optionId), weight, deadline, signature);

    setStatus(`Tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    setStatus(`✅ Voted! ${window.ETHOS_CONFIG.chain.explorer}/tx/${receipt.hash}`);

    await refreshResults();
    await refreshEligibilityAndVoted();
  }catch(e){
    setStatus(e?.shortMessage || e?.reason || e?.message || String(e), true);
  }
}

function renderInitiatorLine(meta){
  const wrap = document.getElementById("pollWho");
  const name = safeText(meta?.initiator?.name || "");
  const url = safeText(meta?.initiator?.url || "");
  const ethosProfile = safeText(meta?.initiator?.ethosProfile || "");

  const nameHtml = url
    ? `<a href="${url}" target="_blank" rel="noreferrer">${name}</a>`
    : `<span>${name}</span>`;

  const ethosHtml = ethosProfile
    ? ` <span class="muted2">|</span> <a href="${ethosProfile}" target="_blank" rel="noreferrer">Ethos profile</a>`
    : "";

  wrap.innerHTML = `${nameHtml}${ethosHtml}`;
}

function setupContractLink(){
  const explorer = window.ETHOS_CONFIG?.chain?.explorer || "https://basescan.org";
  const contractAddr = window.ETHOS_CONFIG?.contracts?.EthosWeightedPoll?.address || "";
  const el = document.getElementById("contractLink");
  if (!el || !contractAddr) return;

  el.href = `${explorer}/address/${contractAddr}`;
  el.style.display = "inline-flex";
}

async function main(){
  try{
    const pollId = qs("id");
    if (!pollId) throw new Error("Missing ?id=");

    setupContractLink();

    const metaAll = await loadPollsMeta();
    const meta = metaAll.find(p => p.id === pollId);
    if (!meta) throw new Error("Poll not found in polls.json");

    const c = await getReadContract();
    const on = await readOnchainPoll(c, pollId);
    if (!on.exists) throw new Error("Poll not created on-chain");

    window.__VOTE_STATE = { pollId, meta, onchain: on, wallet: null, elig: null, hasVoted: false };

    document.getElementById("pollTitle").textContent = safeText(meta.question || meta.id);
    renderInitiatorLine(meta);

    document.getElementById("minScoreBadge").textContent = `Min Ethos score: ${on.minScore}`;

    const det = safeText(meta.details || "");
    if (det){
      const box = document.getElementById("pollDetails");
      box.style.display = "block";
      box.textContent = det;
    }

    const wrap = document.getElementById("options");
    wrap.innerHTML = "";
    (meta.options || []).forEach((opt, i) => {
      const b = document.createElement("button");
      b.className = "btn secondary optionBtn";
      b.textContent = safeText(opt);
      b.onclick = () => vote(i);
      wrap.appendChild(b);
    });

    document.getElementById("refreshResultsBtn").onclick = refreshResults;
    await refreshResults();
    setButtonsEnabled(false);

    await refreshEligibilityAndVoted();

    setInterval(() => {
      const now = Math.floor(Date.now()/1000);
      const s = computeStatus(now, on);
      document.getElementById("statusBadge").textContent = s;
      document.getElementById("pollTime").textContent =
        relativeLabel(now, on.startTime, on.endTime, on.exists);
    }, 1000);

    setInterval(refreshResults, 12000);

    const now0 = Math.floor(Date.now()/1000);
    document.getElementById("statusBadge").textContent = computeStatus(now0, on);
    document.getElementById("pollTime").textContent = relativeLabel(now0, on.startTime, on.endTime, on.exists);

    setStatus("Ready.");
  }catch(e){
    setStatus(e?.message || String(e), true);
  }
}

window.addEventListener("DOMContentLoaded", main);
