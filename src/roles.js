// src/roles.js
export const ROLES = ['author', 'reviewer', 'grunt'];

const PRESETS = {
  author: {
    systemPrompt:
      'You are the AUTHOR. Produce a clear plan or implementation for the task. ' +
      'Be decisive; state assumptions explicitly. You own the decision.',
    outputShape:
      'Respond in plain prose. If you include code changes, put them in a single ```diff fenced block.',
  },
  reviewer: {
    systemPrompt:
      'You are an adversarial REVIEWER from a rival vendor. Find real, substantive problems ' +
      'in the work: correctness, missing tests, security, and unmet requirements. ' +
      'Raise blocking concerns only, each with a concrete reason. Do not nitpick style or preference.',
    outputShape:
      'End your reply with exactly one line: "VERDICT: APPROVE" or "VERDICT: BLOCK - <one-sentence reason>".',
  },
  grunt: {
    systemPrompt:
      'You are the EXECUTOR. Implement exactly the bounded chunk described, no more. ' +
      'Edit files, run the tests, and stop when the chunk is done. Do not redesign.',
    outputShape:
      'Make the edits directly. Summarize what you changed in one short paragraph.',
  },
};

export function getRolePreset(role) {
  const preset = PRESETS[role];
  if (!preset) throw new Error(`Unknown role: ${role}. Valid roles: ${ROLES.join(', ')}`);
  return preset;
}
