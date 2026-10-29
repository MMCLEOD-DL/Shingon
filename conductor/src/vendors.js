// src/vendors.js
// Who actually serves a call. The two-vendor rule compares vendors, not adapter kinds:
// Claude Code on a subscription and the Anthropic API are the same vendor.
const VENDOR = {
  'claude-code': 'anthropic',
  'anthropic-api': 'anthropic',
  codex: 'openai',
  'openai-api': 'openai',
  'local-agent': 'local',
};

export const vendorOf = (kind) => VENDOR[kind] ?? kind;
export const isApiKind = (kind) => kind === 'anthropic-api' || kind === 'openai-api';
export const isSubscriptionKind = (kind) => kind === 'claude-code' || kind === 'codex';
