import "dotenv/config";

const ETHOS_BASE = "https://api.ethos.network/api/v2";

export async function getEthosScoreByAddress(address) {
  if (!address) throw new Error("address required");

  const url = `${ETHOS_BASE}/score/address?address=${encodeURIComponent(address)}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-Ethos-Client": process.env.ETHOS_CLIENT_NAME || "credvote",
    },
  });

  if (r.status === 404) {
    // user not found -> treat as 0
    return { score: 0, level: "unknown" };
  }

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Ethos score fetch failed (${r.status}): ${txt.slice(0, 200)}`);
  }

  const j = await r.json();
  // Expected shape per docs: { score: number, level: string } :contentReference[oaicite:3]{index=3}
  return {
    score: Number(j?.score ?? 0),
    level: String(j?.level ?? "unknown"),
  };
}
