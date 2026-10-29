// src/options.js
export const DEFAULT_OPTIONS = Object.freeze({
  planRounds: 3,          // author/reviewer rounds on the plan
  localRounds: 3,         // local-agent attempts per chunk before frontier takes over
  frontierRounds: 2,      // frontier attempts per chunk before deadlock settlement
  maxChunks: 12,
  testCommand: null,      // e.g. "npm test"; null = no tests configured
  testTimeoutMs: 600000,
  agentTimeoutMs: 1800000,
  localTimeoutMs: 900000, // local grunt calls: a hung local backend gives up after 15 min, not 30
  approveEachChunk: false,
  keepWorkspace: false,   // true: keep the workspace after landed/rejected (the transcript is always kept in <baseDir>/logs)
  allowSameVendor: false, // set by buildTeam when only one AI vendor is healthy (the summary then says so)
  watchDiffs: false,      // true: chunk-done events carry the step's diff (--watch-diffs)
  approvePlan: false,     // true: the user approves the agreed plan before any step runs (spec §8 stop point 1)
  council: false,             // true: Security, Legal and Correctness check the finished change before the gate (--council)
  councilFixRounds: 3,        // how many times blocking council findings go back to be fixed before you are asked
  councilToolTimeoutMs: 600000,
  councilGatesTimeoutMs: 2400000, // 40 minutes: caps the local gates (install, lint, types, tests, build, browser) of one council round
  councilSmokeTimeoutMs: 2400000, // 40 minutes: caps the reliability machine smoke (deploy, backup, restore, alerts, updates)
  councilTools: Object.freeze({}),          // { semgrep: "/path/to/semgrep" | false }, plus axe: "/path/to/axe.min.js" | false (a file): a path not on PATH, or false to turn a check off
  councilAcceptLicences: Object.freeze([]), // licences you accept for THIS project despite the permissive-only rule, e.g. ["LGPL-3.0-only"]
  councilSemgrepConfig: 'p/default',        // Semgrep rules: a registry pack, or a local rules file to run fully offline
  councilMembers: null,   // e.g. ["foundation", "correctness"]; null = Security, Legal and Correctness
  factoryFeature: null,   // { id, tags }: set by conductor build for each feature
  firstChunk: null,       // { title, instructions }: a step decided in advance that runs first; the author plans the rest (factory features)
  confirmLocalFallback: false, // true: ask (hooks.confirmLocalFallback) before the frontier does a step because the local model is down (factory spec §4.2)
});
