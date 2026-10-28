/**
 * Text for the standard PDF fonts. Helvetica in a PDF without an embedded font can only show the Windows-1252
 * character set (WinAnsiEncoding), so every piece of text goes through `toWinAnsi` first: anything outside it prints
 * as `?` rather than as garbage (Plan 12 Review Focus 4).
 */

/** The 27 printable characters Windows-1252 puts at 0x80–0x9F; with ASCII and U+00A0–U+00FF they are its whole set. */
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Characters outside Windows-1252 that have a plain stand-in that reads the same. */
const STAND_INS = new Map([
  ['−', '-'], // the minus sign formatPounds uses: "−£5.00" prints as "-£5.00"
]);

function inCp1252(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRA.has(ch);
}

const SEGMENTER = new Intl.Segmenter('en-GB', { granularity: 'grapheme' });

/**
 * `text` with only characters the standard fonts can show. Tabs and line breaks become a space; other control
 * characters and invisible formatting characters (direction overrides, zero-width spaces) are removed; a decomposed
 * accent is joined to its letter. Each character a reader sees that is still outside Windows-1252 (a letter, an emoji,
 * a flag) becomes one `?`.
 */
export function toWinAnsi(text: string): string {
  const cleaned = text
    .normalize('NFC')
    .replace(/\r\n|[\t\n\v\f\r\u2028\u2029]/g, ' ');
  let out = '';
  // By what a reader sees as one character, so a joined emoji (with its zero-width joiners) becomes a single `?`.
  for (const { segment } of SEGMENTER.segment(cleaned)) {
    const visible = segment.replace(/[\p{Cc}\p{Cf}]/gu, '');
    if (visible === '') continue;
    if (Array.from(visible).every(inCp1252)) out += visible;
    else out += STAND_INS.get(visible) ?? '?';
  }
  return out;
}
