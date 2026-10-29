# Modest-box OCR check

Run on 2026-10-29 by `deploy/smoke/ocr-modest-box.sh` on the throwaway build machine (CT 111 `hf-build`), commit 98d2558.
Host CPU: 13th Gen Intel(R) Core(TM) i9-13900H. The box: `docker run --cpus=2 --memory=2g --network none` with `OCR_CONCURRENCY=1`, image `highland/app:0.2.0`, compared with `highland/app:0.1.0`.
Corpus: `rendered/` (18 receipts with an expected reading), read with `--today 2026-03-31`. The `photos/` folder has no pictures yet (operator follow-up: photograph printed fictional receipts).

**Overall: PASS**

| Measure | Pass | Measured | Result |
|---|---|---|---|
| Median seconds per receipt | ≤ 10 | 0.3 s | PASS |
| Slowest receipt | ≤ 30 s (below OCR_TIMEOUT_MS) | 0.5 s (supermarket-photo.jpg) | PASS |
| Out-of-memory kills | none | none (peak memory 217.4 MB of 2 GB) | PASS |
| `confidentlyWrong` (all fields) | 0 | 0 | PASS |
| Network | none needed (`--network none` succeeds) | every run finished with --network none (rendered: exit 0) | PASS |
| App image growth over v0.1.0 | ≤ 60 MB | -36.3 MB by docker image inspect .Size (164318330 vs 200635794 bytes); 33.5 MB by the image's files (369007399 vs 335479334 bytes) | PASS |

## By field

| Field | Right | Wrong, marked "Please check" | Wrong and shown as certain | Not found |
|---|---|---|---|---|
| amount | 17 of 18 | 1 | 0 | 0 |
| vat | 17 of 18 | 1 | 0 | 0 |
| date | 18 of 18 | 0 | 0 | 0 |
| merchant | 18 of 18 | 0 | 0 | 0 |

## By receipt

| Receipt | Seconds | Total | VAT | Date | Merchant |
|---|---|---|---|---|---|
| cafe-clean.png | 0.3 | right | right | right | right |
| cafe-photo.jpg | 0.5 | right | right | right | right |
| fuel-clean.png | 0.2 | right | right | right | right |
| fuel-photo.jpg | 0.3 | right | right | right | right |
| hotel-clean.png | 0.2 | right | right | right | right |
| hotel-photo.jpg | 0.4 | right | right | right | right |
| restaurant-clean.png | 0.2 | right | right | right | right |
| restaurant-photo.jpg | 0.3 | right | right | right | right |
| smudged-clean.png | 0.2 | right | right | right | right |
| smudged-heavy-photo.jpg | 0.4 | right | right | right | right |
| smudged-heavy.png | 0.2 | wrongFlagged | right | right | right |
| smudged-photo.jpg | 0.4 | right | right | right | right |
| supermarket-clean.png | 0.4 | right | right | right | right |
| supermarket-photo.jpg | 0.5 | right | wrongFlagged | right | right |
| taxi-clean.png | 0.2 | right | right | right | right |
| taxi-photo.jpg | 0.4 | right | right | right | right |
| train-clean.png | 0.2 | right | right | right | right |
| train-photo.jpg | 0.3 | right | right | right | right |

## PDF reading inside the image

The PDF folder was read in the same modest box, through the PDF reader's child process (`modules/ocr/dist/pdfChild.js`) and pdfjs-dist without its native canvas: the e-ticket PDF's text was read and its total was right (exit 0).
- e-ticket.pdf: amount right, vat right, date right, merchant right, 0.2 s.

## Notes on the figures

- **Image size.** On this machine Docker uses the containerd image store on ZFS, so `docker image inspect .Size` depends on which layers other images share and on ZFS compression: it came out negative above with both images present. Measured one image at a time, `.Size` was 140 962 706 bytes for `highland/app:0.1.0` and 164 318 330 bytes for `highland/app:0.2.0` (+23.4 MB); the compressed content (what `docker save` ships) went from 100 MB to 117 MB (+17 MB). The stable figure is the image's files in apparent bytes: **+33.5 MB**. Every measure is within the 60 MB gate. An earlier trial build that left out only pdfjs-dist's native canvas (about 20 MB), the legacy 4.0.0 model and some Tesseract engine files measured +77.7 MB by the files' apparent bytes, over the gate; also leaving out pdfjs-dist's browser builds, the browser copies of the engines and every source map brought it to +33.5 MB.
- **Memory.** The corpus pictures are small (the browser sends photos at most 2000 px on the long side), so the peak here is about 220 MB. A picture near the 25-megapixel limit costs about 500 MB per reader, which still fits 2 GB with `OCR_CONCURRENCY=1`.
- **Engine files.** tesseract.js 7.0.0 in Node loads the full Tesseract engines (`tesseract-core-relaxedsimd.js` on this CPU), not the `-lstm` ones, because it passes a boolean where its `getCore` expects the engine mode. The image keeps both kinds (the `.js` loader and `.wasm` file of each) and drops only the browser copies (`*.wasm.js`).
