window.ETHOS_CONFIG = {
  chain: {
    name: "Base Mainnet",
    chainId: 8453,
    explorer: "https://basescan.org",
  },

  // основной + fallback (если один упал)
  rpcs: [
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
    "https://mainnet.base.org",
  ],

  // оставим для совместимости, но код будет использовать rpcs[]
  rpc: "https://base.llamarpc.com",

  contracts: {
    EthosWeightedPoll: {
      address: "0xB58797451bd7f356306dB56a16eD8173354BD661",
    },
  },
};
