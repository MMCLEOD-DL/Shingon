# Changelog

## [Unreleased]
- Optional modules: app-profile.json chooses modules and the data policy; money helpers in whole pence.
- Node 22.13 or later is now needed (`engines.node` `>=22.13`), because the PDF reader the receipt module uses requires it.
- Receipt reading on the box itself: Tesseract (tesseract.js, model read from disk, never downloaded), the text of PDF receipts, a corpus of fictional rendered receipts, and `npm run test:ocr` with an accuracy report in `reports/`.
- Each PDF receipt is read in a short-lived process of its own, held to 320 MB of memory; pictures over 25 megapixels are refused before they are read.
- Receipt reading in the cloud (Azure Document Intelligence `prebuilt-receipt`), only when app-profile.json's data policy allows `azure-document-intelligence`, `OCR_AZURE_ENDPOINT` is a plain `https://<name>.cognitiveservices.azure.com` address, the region fits the residency and `.env` sets `OCR_ENGINE=azure`; anything else stops the app at start with a plain sentence and nothing is sent. If the cloud can't be reached the receipt is read on the box instead. `OCR_AZURE_REGION` is the region the operator declares for the Azure resource; the app does not detect it, so the operator must check it matches the resource. Tested only against a stand-in; the field names are to be checked against the live service before first real use.

## [0.1.0] - 2026-10-26
- First foundation release: accounts, roles, role-crossing harness, files, email, audit, visual system, backups, monitoring, safe update.
