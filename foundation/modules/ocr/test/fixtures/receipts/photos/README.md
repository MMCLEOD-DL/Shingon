# Photos of printed fictional receipts

This folder starts empty. It holds phone photos of **fictional** receipts only — never a real receipt, never client
data (Ruling 10).

To add photos:

1. Print one of the fictional receipts, for example `../rendered/cafe-clean.png`, or open a template from
   `../../templates/` in a browser and print it. Crumple it, fold it, or let it fade if you like.
2. Photograph it with a phone, in ordinary light, the way staff would. Save it here as JPEG, PNG or WebP
   (not HEIC: on an iPhone choose "Most Compatible" under Settings > Camera > Formats, or export as JPEG).
3. Add what the receipt says to `expected.json` in this folder (create it if it isn't here yet), keyed by the
   photo's file name. Copy the values from `../expected.json` for the receipt you printed:

   ```json
   {
     "cafe-crumpled.jpg": { "amountPence": 875, "vatPence": 146, "date": "2026-03-05", "merchant": "Corner Café" }
   }
   ```

4. Run `npm run test:ocr`. The photos are read by the local engine and scored like the rendered corpus; the rule is
   that no field is ever wrong while shown as certain. The report is written to `reports/ocr-accuracy-photos.md`.

Photos without an `expected.json` entry are ignored.
