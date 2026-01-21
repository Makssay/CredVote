import { ethers } from "ethers";
import { getEthosScoreByAddress } from "./_lib/ethos.js";
import { scoreToWeight } from "./_lib/weight.js";

const POLL_ABI = [
  "function polls(bytes32) view returns (bool exists,uint32 optionsCount,uint64 startTime,uint64 endTime,uint32 minScore)"
];

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { pollId, optionId, voter } = req.body || {};
    if (!pollId || typeof pollId !== "string") throw new Error("pollId required");
    if (optionId === undefined || optionId === null) throw new Error("optionId required");
    if (!voter || typeof voter !== "string") throw new Error("voter required");

    const rpc = process.env.BASE_MAINNET_RPC || "https://mainnet.base.org";
    const contractAddress = process.env.CONTRACT_ADDRESS;
    const oraclePk = process.env.ORACLE_PRIVATE_KEY;

    if (!contractAddress) throw new Error("Missing CONTRACT_ADDRESS");
    if (!oraclePk) throw new Error("Missing ORACLE_PRIVATE_KEY");

    // read poll params on-chain
    const provider = new ethers.JsonRpcProvider(rpc);
    const pollRead = new ethers.Contract(contractAddress, POLL_ABI, provider);

    const pollIdBytes32 = ethers.id(pollId);
    const p = await pollRead.polls(pollIdBytes32);

    const exists = Boolean(p[0]);
    const startTime = Number(p[2]);
    const endTime = Number(p[3]);
    const minScore = Number(p[4]);

    if (!exists) return res.status(400).json({ error: "poll_not_exists" });

    const now = Math.floor(Date.now() / 1000);
    if (now < startTime) return res.status(400).json({ error: "poll_not_started" });
    if (now > endTime) return res.status(400).json({ error: "poll_ended" });

    // ethos score
    const { score } = await getEthosScoreByAddress(voter);
    if (score < minScore) {
      return res.status(403).json({
        error: "not_eligible",
        minScore,
        score,
      });
    }

    const weight = scoreToWeight(score);

    // EIP-712 domain MUST match contract's EIP712(name,version)
    const domain = {
      name: "EthosWeightedPoll",
      version: "1",
      chainId: 8453,
      verifyingContract: contractAddress,
    };

    const types = {
      Vote: [
        { name: "pollId", type: "bytes32" },
        { name: "voter", type: "address" },
        { name: "optionId", type: "uint32" },
        { name: "weight", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const deadline = BigInt(now + 10 * 60);

    const message = {
      pollId: pollIdBytes32,
      voter,
      optionId: Number(optionId),
      weight,
      deadline,
    };

    const pk = oraclePk.startsWith("0x") ? oraclePk : "0x" + oraclePk;
    const wallet = new ethers.Wallet(pk);

    const signature = await wallet.signTypedData(domain, types, message);

    res.status(200).json({
      weight: weight.toString(),
      deadline: deadline.toString(),
      signature,
      score,
      minScore,
    });
  } catch (e) {
    res.status(400).json({ error: e?.message || "sign-vote error" });
  }
}

