window.ETHOS_CONFIG = {
  chain: {
    name: "Base Mainnet",
    chainId: 8453,
    explorer: "https://basescan.org",
  },

  // Важно: порядок имеет значение. Берём самые стабильные вверх.
  rpcs: [
    "https://base-rpc.publicnode.com",
    "https://base.public.blockpi.network/v1/rpc/public",
    "https://base.meowrpc.com",
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
    "https://mainnet.base.org",
  ],

  // оставим для обратной совместимости
  rpc: "https://base-rpc.publicnode.com",

  contracts: {
    EthosWeightedPoll: {
      address: "0xB58797451bd7f356306dB56a16eD8173354BD661",
    },
  },
};
