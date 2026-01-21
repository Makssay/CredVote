let POLLS = [];

function $(id) {
  return document.getElementById(id);
}

function shortAddr(a) {
  if (!a || typeof a !== "string" || a.length < 10) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function setStatus(msg, isError = false) {
  const el = $("status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? "tomato" : "rgba(255,255,255,.84)";
}

function setNet(ok, text) {
  const dot = $("netDot");
  const t = $("netText");
  if (!dot || !t) return;
  dot.className = "dot" + (ok ? " ok" : " bad");
  t.textContent = text;
}

function requireConfig() {
  const cfg = window.ETHOS_CONFIG;
  if (!cfg?.contracts?.EthosWeightedPoll?.address) throw new Error("Missing contract address in config.js");
  if (!cfg?.chain?.chainId) throw new Error("Missing chain config in config.js");
  if (!window.ETHOS_POLL_ABI) throw new Error("Missing ETHOS_POLL_ABI (ethosPollAbi.js)");
  if (!window.getPollContract) throw new Error("Missing helpers (chain.js)");
}

async function loadPollsJson() {
  const res = await fetch("./data/polls.json", { cache: "no-store" });
  if (!res.ok) throw new Error("polls.json not found: ./data/polls.json");

  const data = await res.json();
  const arr = Array.isArray(data) ? data : (Array.isArray(data.polls) ? data.polls : null);
  if (!arr) throw new Error("polls.json должен быть массивом или { polls: [...] }");

  POLLS = arr;
}

function renderPollSelect() {
  const sel = $("pollSelect");
  sel.innerHTML = "";
  for (const p of POLLS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    const q = (p.question || "").toString().replace(/\s+/g, " ").trim();
    opt.textContent = `${p.id} — ${q.slice(0, 90)}`;
    sel.appendChild(opt);
  }
}

function getSelectedPoll() {
  const id = $("pollSelect").value;
  return POLLS.find(p => p.id === id);
}

function unixFromDatetimeLocal(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

async function refreshInfo() {
  try {
    requireConfig();

    $("infoChain").textContent = `${window.ETHOS_CONFIG.chain.name} (${window.ETHOS_CONFIG.chain.chainId})`;
    $("infoContract").textContent = window.ETHOS_CONFIG.contracts.EthosWeightedPoll.address;

    if (!window.ethereum) {
      $("infoWallet").textContent = "—";
      $("infoOracle").textContent = "—";
      setNet(false, "No wallet");
      return;
    }

    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const wallet = accounts?.[0] ? accounts[0] : "—";
    $("infoWallet").textContent = wallet;

    if (!accounts?.[0]) {
      $("infoOracle").textContent = "—";
      setNet(false, "Not connected");
      return;
    }

    await window.ensureBaseMainnet();
    const c = await window.getPollContract();
    const oracle = await c.oracleSigner();
    $("infoOracle").textContent = oracle;

    setNet(true, `Connected: ${shortAddr(wallet)}`);
  } catch (e) {
    setStatus(e?.shortMessage || e?.reason || e?.message || "Refresh error", true);
  }
}

async function onConnect() {
  try {
    requireConfig();
    if (!window.ethereum) throw new Error("Wallet not found (window.ethereum)");

    await window.ethereum.request({ method: "eth_requestAccounts" });
    await window.ensureBaseMainnet();

    const signer = await window.getSigner();
    const addr = await signer.getAddress();

    setNet(true, `Connected: ${shortAddr(addr)}`);
    setStatus(`✅ Connected\nWallet: ${addr}\nChainId: ${window.ETHOS_CONFIG.chain.chainId}`);

    await refreshInfo();
  } catch (e) {
    setNet(false, "Not connected");
    setStatus(e?.shortMessage || e?.reason || e?.message || "Connect error", true);
  }
}

async function onCheckOnchain() {
  try {
    requireConfig();
    await window.ensureBaseMainnet();

    const poll = getSelectedPoll();
    if (!poll) throw new Error("No poll selected");

    const c = await window.getPollContract();
    const pollId = window.toPollIdBytes32(poll.id);

    const p = await c.polls(pollId);
    const exists = p[0];
    const optionsCount = Number(p[1]);
    const startTime = Number(p[2]);
    const endTime = Number(p[3]);
    const minScore = Number(p[4]);

    if (!exists) {
      setStatus(`On-chain: ❌ not exists\npollId=${poll.id}`);
      return;
    }

    setStatus(
      `On-chain: ✅ exists\n` +
      `pollId=${poll.id}\n` +
      `options=${optionsCount}\n` +
      `start=${startTime} (${new Date(startTime * 1000).toISOString()})\n` +
      `end=${endTime} (${new Date(endTime * 1000).toISOString()})\n` +
      `minScore=${minScore}`
    );
  } catch (e) {
    setStatus(e?.shortMessage || e?.reason || e?.message || "Check error", true);
  }
}

async function onCreatePoll() {
  try {
    requireConfig();
    if (!window.ethereum) throw new Error("Wallet not found");

    await window.ethereum.request({ method: "eth_requestAccounts" });
    await window.ensureBaseMainnet();

    const poll = getSelectedPoll();
    if (!poll) throw new Error("No poll selected");
    if (!Array.isArray(poll.options) || poll.options.length < 2) throw new Error("poll.options must have >= 2");

    const startTime = unixFromDatetimeLocal($("startTime").value);
    const endTime = unixFromDatetimeLocal($("endTime").value);
    if (!startTime || !endTime) throw new Error("Set start/end time");
    if (endTime <= startTime) throw new Error("endTime must be > startTime");

    const minScore = Number($("minScore").value || "0");
    if (!Number.isFinite(minScore) || minScore < 0) throw new Error("Bad minScore");

    const c = await window.getPollContract();
    const pollId = window.toPollIdBytes32(poll.id);

    setStatus("Sending tx createPoll...");

    const tx = await c.createPoll(
      pollId,
      Number(poll.options.length),
      BigInt(startTime),
      BigInt(endTime),
      Number(minScore)
    );

    const txUrl = `${window.ETHOS_CONFIG.chain.explorer}/tx/${tx.hash}`;
    setStatus(`⛓️ Tx sent\n${tx.hash}\n${txUrl}`);

    const receipt = await tx.wait();
    setStatus(`✅ Poll created!\n${window.ETHOS_CONFIG.chain.explorer}/tx/${receipt.hash}`);
  } catch (e) {
    setStatus(e?.shortMessage || e?.reason || e?.message || "Create poll error", true);
  }
}

function onPollChange() {
  const p = getSelectedPoll();
  if (!p) return;

  // Prefill times if empty: now -> +1h
  if (!$("startTime").value || !$("endTime").value) {
    const fmt = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    $("startTime").value = fmt(new Date());
    $("endTime").value = fmt(new Date(Date.now() + 60 * 60 * 1000));
  }

  const q = (p.question || "").toString().trim();
  setStatus(`Selected poll:\n${p.id}\nQ: ${q}\nOptions: ${Array.isArray(p.options) ? p.options.length : 0}`);
}

async function init() {
  try {
    requireConfig();
    await loadPollsJson();
    renderPollSelect();

    $("connectBtn").addEventListener("click", onConnect);
    $("checkBtn").addEventListener("click", onCheckOnchain);
    $("createBtn").addEventListener("click", onCreatePoll);
    $("pollSelect").addEventListener("change", onPollChange);
    $("refreshInfoBtn").addEventListener("click", refreshInfo);

    setNet(false, "Not connected");
    setStatus("Admin ready. polls.json loaded ✅");

    onPollChange();
    refreshInfo();
  } catch (e) {
    setNet(false, "Init error");
    setStatus(e?.message || "Init error", true);
  }
}

window.addEventListener("DOMContentLoaded", init);
