window.ETHOS_CONFIG = {
  chain: {
    name: "Base Mainnet",
    chainId: 8453,
    explorer: "https://basescan.org",
  },

  // список RPC (первый — приоритетный)
  // важно: они должны нормально работать из браузера
  rpcs: [
    "https://base-rpc.publicnode.com",
    "https://1rpc.io/base",
    "https://mainnet.base.org"
  ],

  // оставим для обратной совместимости
  rpc: "https://base-rpc.publicnode.com",

  contracts: {
    EthosWeightedPoll: {
      address: "0xB58797451bd7f356306dB56a16eD8173354BD661",
    },
  },
};
