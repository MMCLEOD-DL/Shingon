"""Turns source files into chunks with the finest locator each format allows (page, section path, sheet and
cell range). Every failure is an ImportProblem whose message is what the operator sees in the import status.

These are the spike's simple parsers. K5 replaces them with Docling + OCRmyPDF in an isolated worker.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader

MAX_CHUNK = 1500
MAX_FILE_BYTES = 50 * 1024 * 1024


class ImportProblem(Exception):
    """A file that can't be indexed. The message is shown to the operator, so it must say what to do."""


@dataclass
class Chunk:
    text: str
    locator: dict


def _split(text: str, locator: dict) -> list[Chunk]:
    out, buf = [], ''
    for para in text.split('\n'):
        if buf and len(buf) + len(para) > MAX_CHUNK:
            out.append(Chunk(buf.strip(), locator))
            buf = ''
        buf += para + '\n'
    if buf.strip():
        out.append(Chunk(buf.strip(), locator))
    return out


def _sections(lines, title_default: str) -> tuple[str, list[Chunk]]:
    """Groups (level|None, text) lines under their heading path."""
    title, stack, chunks, body = title_default, [], [], []

    def flush():
        if body and ''.join(body).strip():
            chunks.extend(_split('\n'.join(body), {'sectionPath': list(stack)}))
        body.clear()

    for level, text in lines:
        if level is not None and text:
            flush()
            if level == 1 and title == title_default:
                title = text
            del stack[level - 1:]
            stack.append(text)
        elif text:
            body.append(text)
    flush()
    return title, chunks


def parse_markdown(path: Path) -> tuple[str, list[Chunk]]:
    def lines():
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            m = re.match(r'^(#{1,6})\s+(.*)', line)
            yield (len(m.group(1)), m.group(2).strip()) if m else (None, line)
    return _sections(lines(), path.stem)


def parse_docx(path: Path) -> tuple[str, list[Chunk]]:
    def lines():
        for p in Document(str(path)).paragraphs:
            style = p.style.name if p.style is not None else ''
            m = re.match(r'Heading (\d)', style)
            yield (int(m.group(1)) if m else None, p.text.strip())
    return _sections(lines(), path.stem)


def parse_pdf(path: Path) -> tuple[str, list[Chunk]]:
    try:
        reader = PdfReader(str(path))
    except Exception as e:  # noqa: BLE001 - any parser failure is an import problem, not a crash
        raise ImportProblem(f'The PDF could not be opened ({type(e).__name__}).') from e
    if reader.is_encrypted:
        raise ImportProblem('The PDF is password-protected. Remove the password at the source, then import it again.')
    chunks, title = [], path.stem
    for n, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or '').strip()
        if text:
            if title == path.stem:
                title = text.splitlines()[0].strip()
            chunks.extend(_split(text, {'page': n}))
    if not chunks:
        raise ImportProblem('The PDF has no text layer (a scan). No OCR engine is configured, so it was not indexed.')
    return title, chunks


def parse_xlsx(path: Path) -> tuple[str, list[Chunk]]:
    # data_only: the cached results of formulas, which exist only if a spreadsheet program last saved the file.
    wb = load_workbook(str(path), data_only=True, read_only=True)
    chunks, uncached = [], 0
    for ws in wb.worksheets:
        rows = list(ws.iter_rows())
        if not rows:
            continue
        header = [str(c.value) if c.value is not None else '' for c in rows[0]]
        for r in rows[1:]:
            cells = [(header[i] if i < len(header) else f'col{i + 1}', c) for i, c in enumerate(r)]
            if all(c.value is None for _h, c in cells):
                continue
            uncached += sum(1 for _h, c in cells if c.value is None)
            text = '; '.join(f'{h}: {c.value}' for h, c in cells if c.value is not None)
            chunks.append(Chunk(f'{ws.title} — {text}', {'sheet': ws.title, 'cellRange': f'{r[0].coordinate}:{r[-1].coordinate}'}))
    if uncached:
        chunks.append(Chunk(f'[import note] {uncached} cells had formulas with no saved result and were not indexed.',
                            {'sheet': None, 'cellRange': None, 'importNote': True}))
    return path.stem, chunks


PARSERS = {'.md': parse_markdown, '.markdown': parse_markdown, '.docx': parse_docx, '.pdf': parse_pdf, '.xlsx': parse_xlsx}

# Credential shapes that must never be indexed or embedded (recommendation.md "Security summary").
# Built from parts so this file does not itself look like a secret to scanners.
_SECRET_PATTERNS = [
    ('a private key', re.compile('-----BEGIN ' + r'(?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY' + '-----')),
    ('an AWS access key', re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b')),
    ('a GitHub token', re.compile(r'\bgh[pousr]_[A-Za-z0-9]{36,}\b')),
    ('an API key', re.compile(r'\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b')),
    ('a password or secret assignment', re.compile(r'(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["\']?[^\s"\']{8,}')),
]


def find_secret(text: str) -> str | None:
    """The kind of credential found in text, or None."""
    for kind, pattern in _SECRET_PATTERNS:
        if pattern.search(text):
            return kind
    return None


def parse(path: Path) -> tuple[str, list[Chunk]]:
    """Parses one file, refusing unsupported types, oversized files and files that contain credentials."""
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ImportProblem(f'The file is {size // (1024 * 1024)} MB; the limit is {MAX_FILE_BYTES // (1024 * 1024)} MB. Split it or leave it out.')
    parser = PARSERS.get(path.suffix.lower())
    if parser is None:
        raise ImportProblem(f'Files of type "{path.suffix or "none"}" are not supported, so it was not indexed.')
    try:
        title, chunks = parser(path)
    except ImportProblem:
        raise
    except Exception as e:  # noqa: BLE001 - a malformed file must not stop the whole sync
        raise ImportProblem(f'The file could not be read ({type(e).__name__}). Check it opens normally, then import it again.') from e
    kind = find_secret(title + '\n' + '\n'.join(c.text for c in chunks))
    if kind:
        raise ImportProblem(f'The file appears to contain {kind}, so it was not indexed. Remove the secret at the source, then import it again.')
    return title, chunks
