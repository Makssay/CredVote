window.getSigner = async () => {
  if (!window.ethereum) throw new Error("No wallet found");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  return provider.getSigner();
};

// ЕДИНЫЙ способ формирования pollId (bytes32) из строкового id
window.toPollIdBytes32 = (pollIdStr) => {
  return ethers.id(String(pollIdStr)); // keccak256(utf8)
};

// ---------- READ provider with fallback ----------
function rpcCandidates() {
  const cfg = window.ETHOS_CONFIG || {};
  const list = Array.isArray(cfg.rpcs) ? cfg.rpcs : [];
  const single = cfg.rpc ? [cfg.rpc] : [];
  return [...new Set([...list, ...single].filter(Boolean))];
}

window.getReadProvider = async () => {
  const cands = rpcCandidates();
  if (!cands.length) throw new Error("No RPC configured in config.js");

  let lastErr = null;
  for (const url of cands) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      // health-check
      await p.getBlockNumber();
      return p;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("All RPC endpoints are down. Last error: " + (lastErr?.message || lastErr));
};

window.getReadContract = async () => {
  const provider = await window.getReadProvider();
  const addr = window.ETHOS_CONFIG.contracts.EthosWeightedPoll.address;
  return new ethers.Contract(addr, window.ETHOS_POLL_ABI, provider);
};

// ---------- WRITE contract (signer / wallet) ----------
window.getPollContract = async () => {
  const signer = await window.getSigner();
  const addr = window.ETHOS_CONFIG.contracts.EthosWeightedPoll.address;
  return new ethers.Contract(addr, window.ETHOS_POLL_ABI, signer);
};

window.ensureBaseMainnet = async () => {
  const wanted = "0x" + Number(window.ETHOS_CONFIG.chain.chainId).toString(16);
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (cur === wanted) return;
  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: wanted }],
  });
};
