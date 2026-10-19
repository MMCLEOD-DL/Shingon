// src/options.js
export const DEFAULT_OPTIONS = Object.freeze({
  planRounds: 3,          // author/reviewer rounds on the plan
  localRounds: 3,         // local-agent attempts per chunk before frontier takes over
  frontierRounds: 2,      // frontier attempts per chunk before deadlock settlement
  maxChunks: 12,
  testCommand: null,      // e.g. "npm test"; null = no tests configured
  testTimeoutMs: 600000,
  agentTimeoutMs: 1800000,
  approveEachChunk: false,
  keepWorkspace: false,   // true: keep the workspace after landed/rejected (the transcript is always kept in <baseDir>/logs)
});
