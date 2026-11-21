module.exports.wordCount = (words) => {
  const m = new Map();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
};
