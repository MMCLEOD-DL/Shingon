# Changelog

## [Unreleased]
- Optional modules: app-profile.json chooses modules and the data policy; money helpers in whole pence.
- Node 22.13 or later is now needed (`engines.node` `>=22.13`), because the PDF reader the receipt module uses requires it.
- Receipt reading on the box itself: Tesseract (tesseract.js, model read from disk, never downloaded), the text of PDF receipts, a corpus of fictional rendered receipts, and `npm run test:ocr` with an accuracy report in `reports/`.
- Each PDF receipt is read in a short-lived process of its own, held to 320 MB of memory; pictures over 25 megapixels are refused before they are read.

## [0.1.0] - 2026-10-26
- First foundation release: accounts, roles, role-crossing harness, files, email, audit, visual system, backups, monitoring, safe update.
