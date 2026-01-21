import { ethers } from "ethers";
import { getEthosScoreByAddress } from "./_lib/ethos.js";
import { SCORE_TIERS, scoreToWeight } from "./_lib/weight.js";

const POLL_ABI = [
  "function polls(bytes32) view returns (bool exists,uint32 optionsCount,uint64 startTime,uint64 endTime,uint32 minScore)"
];

export default async function handler(req, res) {
  try {
    const pollId = (req.query?.pollId || "").toString();
    const address = (req.query?.address || "").toString();

    if (!pollId) throw new Error("pollId required");
    if (!address) throw new Error("address required");

    const rpc = process.env.BASE_MAINNET_RPC || "https://mainnet.base.org";
    const contractAddress = process.env.CONTRACT_ADDRESS;
    if (!contractAddress) throw new Error("Missing CONTRACT_ADDRESS");

    const provider = new ethers.JsonRpcProvider(rpc);
    const c = new ethers.Contract(contractAddress, POLL_ABI, provider);

    const pollIdBytes32 = ethers.id(pollId);
    const p = await c.polls(pollIdBytes32);

    const exists = Boolean(p[0]);
    const optionsCount = Number(p[1]);
    const startTime = Number(p[2]);
    const endTime = Number(p[3]);
    const minScore = Number(p[4]);

    if (!exists) {
      return res.status(200).json({
        pollId,
        exists: false,
        eligible: false,
        reason: "poll_not_exists",
        minScore,
        tiers: SCORE_TIERS,
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const active = now >= startTime && now <= endTime;

    const { score, level } = await getEthosScoreByAddress(address);

    const eligible = score >= minScore;
    const weight = eligible ? scoreToWeight(score) : 0n;

    return res.status(200).json({
      pollId,
      exists,
      optionsCount,
      startTime,
      endTime,
      active,
      minScore,
      ethos: { score, level },
      eligible,
      weight: weight.toString(),
      tiers: SCORE_TIERS,
    });
  } catch (e) {
    res.status(400).json({ error: e?.message || "eligibility error" });
  }
}

