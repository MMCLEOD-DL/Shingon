// src/text.js
// Keep prompts and logs bounded: head + tail survive, the middle is elided.
export function clip(text, max = 8000) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…[${s.length - half * 2} chars clipped]…\n${s.slice(-half)}`;
}
