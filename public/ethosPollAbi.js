window.ETHOS_POLL_ABI = [
  "function owner() view returns (address)",
  "function oracleSigner() view returns (address)",

  "function createPoll(bytes32 pollId,uint32 optionsCount,uint64 startTime,uint64 endTime,uint32 minScore)",
  "function castVote(bytes32 pollId,uint32 optionId,uint256 weight,uint256 deadline,bytes signature)",

  "function polls(bytes32) view returns (bool exists,uint32 optionsCount,uint64 startTime,uint64 endTime,uint32 minScore)",
  "function hasVoted(bytes32,address) view returns (bool)",

  "function tally(bytes32,uint32) view returns (uint256)",
  "function getTallies(bytes32) view returns (uint256[])",

  "event PollCreated(bytes32 indexed pollId,address indexed creator,uint32 optionsCount,uint64 startTime,uint64 endTime,uint32 minScore)",
  "event VoteCast(bytes32 indexed pollId,address indexed voter,uint32 indexed optionId,uint256 weight)"
];
