# Task 6: Confirm or correct on the phone

**Repo: `/root/highland-foundation`.**

The staff side of spec §2.5: take a photo (or choose a file), see the receipt read for you, check the fields marked "Please check", fix anything wrong, and confirm. This task adds:
- **photo preparation in the browser**, which also solves HEIC and sideways photos (Review Focus 2);
- the reusable **`ReceiptReadingFields`** component, the "confirm or correct" pattern client features copy;
- two **example pages**, like notes: client apps keep, change or remove them.

**Files:**
- Create: `apps/web/src/modules/ocr/{prepareImage.ts,useReading.ts,ReceiptReadingFields.tsx,ReceiptNew.tsx,ReceiptCheck.tsx,index.ts}`
- Modify: `apps/web/src/ui/FileDropzone.tsx` (optional `prepare` prop), `apps/web/src/api.ts` (`requestReading`, `getReading`, `confirmReading`), `apps/web/src/appPaths.ts` (`module?` on `AppPath`; two entries), `apps/web/src/routes.tsx`, `apps/web/src/nav.ts` (a "Receipts" entry when `ocr` is on), `apps/web/vite.config.ts` (`HF_ALL_MODULES=1` turns every module on for the e2e build), root `package.json` (`test:e2e` sets `HF_ALL_MODULES=1`)
- Modify: `apps/web/e2e/{pages.ts,fixtures.ts,flows.spec.ts,registry.spec.ts}`; create `apps/web/e2e/files/receipt-exif-rotated.jpg` (a portrait receipt photo stored landscape with EXIF orientation 6, made by `apps/web/e2e/files/make-exif.ts`, committed)
- Test: `apps/web/src/modules/ocr/ReceiptReadingFields.test.tsx`, `apps/web/src/modules/ocr/useReading.test.tsx`, the e2e specs above; test helpers `readWith(fields)` (a `read` `ReadingView` from `[value, confidence]` pairs), `confirmedView()`, `mockApi(name, result)` and `fieldOf(label)` in `apps/web/src/modules/ocr/testHelpers.tsx`

**Interfaces:**
- Consumes: the three routes and `ReadingView` (Task 5); `ConfirmReadingInput`, `CONFIDENT`, `formatPounds`, `toPence` (`@hf/shared`); house components `PageHeader`, `FormCard`, `FileDropzone`, `FilePreview`, `ErrorNotice` (Plan 6); `__HF_MODULES__` (Task 1).
- Produces:
  - `prepareReceiptImage(file, opts)` (index);
  - `<ReceiptReadingFields reading: ReadingView; canConfirm: boolean; onConfirmed(r: ReadingView): void />`;
  - `useReading(id: string): { reading: ReadingView | undefined; error: unknown }`: polls every 1500 ms while `pending`, stops after 90 s with `Reading is taking longer than usual. You can type the details now.`;
  - pages `/receipts/new` (heading **Read a receipt**) and `/receipts/:id` (heading **Check the details**), both `auth: 'signed-in'`, `module: 'ocr'`.

Copy (exact):
- Pending: `Reading your receipt…`
- Field badge below `CONFIDENT`: `Please check`
- Unreadable: the reading's `problem`, then `Type the details below.`
- Warnings: each of `proposal.warnings` as a line above the fields.
- Button: `Confirm`; after it, a green notice `Receipt confirmed.` and the fields shown read-only.
- Manager viewing a team member's reading: read-only fields and `Only the person who uploaded this receipt can confirm it.`
- Field labels: `Total`, `VAT`, `Date`, `Shop or supplier`. The VAT field has a `No VAT shown` checkbox (sends `vatPence: null`).

- [ ] **Step 1: Write the failing component tests** (Vitest + Testing Library, jsdom)

`ReceiptReadingFields.test.tsx`:

```tsx
test('fields arrive pre-filled; low-confidence ones say Please check', () => {
  render(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [270, 0.5], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.6] })} canConfirm onConfirmed={vi.fn()} />);
  expect(screen.getByLabelText('Total')).toHaveValue('12.40');
  expect(screen.getByLabelText('VAT')).toHaveValue('2.70');
  expect(within(fieldOf('VAT')).getByText('Please check')).toBeVisible();
  expect(within(fieldOf('Shop or supplier')).getByText('Please check')).toBeVisible();
  expect(within(fieldOf('Total')).queryByText('Please check')).toBeNull();
});

test('nothing is saved until Confirm, and the corrected values are what is sent', async () => {
  const confirm = mockApi('confirmReading', confirmedView());
  render(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [270, 0.5] })} canConfirm onConfirmed={vi.fn()} />);
  await user.clear(screen.getByLabelText('VAT'));
  await user.type(screen.getByLabelText('VAT'), '2.07');
  expect(confirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(confirm).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ amountPence: 1240, vatPence: 207 }));
});

test('an unreadable receipt shows the reason and an empty form that still works', () => {});
test('VAT above the total is caught before sending, with the server\'s sentence', () => {});
test('a manager sees read-only fields and the explanation, with no Confirm button', () => {});
test('a confirmed reading is shown read-only', () => {});
```

`useReading.test.tsx`: polls while `pending`, stops on `read`, and gives the "longer than usual" message after 90 s (fake timers).

- [ ] **Step 2: Write the failing browser tests**

`apps/web/e2e/pages.ts` adds (and `fixtures.ts` gains `memberReadingToCheck`, the seeded `read` reading, and `memberReadingConfirmed`):

```ts
{ name: 'receipt-new', route: '/receipts/new', path: '/receipts/new', as: 'member', ready: 'Read a receipt' },
{ name: 'receipt-check', route: '/receipts/:id', path: (fx) => `/receipts/${fx.memberReadingToCheck}`, as: 'member', ready: 'Check the details' },
{ name: 'receipt-confirmed', route: '/receipts/:id', path: (fx) => `/receipts/${fx.memberReadingConfirmed}`, as: 'member', ready: 'Check the details' },
{ name: 'receipt-check-manager', route: '/receipts/:id', path: (fx) => `/receipts/${fx.memberReadingToCheck}`, as: 'manager', ready: 'Check the details' },
```

`flows.spec.ts` adds (desktop and phone Chromium):
- `'receipt: choose a file, read, correct, confirm'`: sign in as a flow member, open `/receipts/new`, use **Choose a file** (`setInputFiles` on that control) with Task 3's `taxi-photo.jpg` → lands on **Check the details** → `Reading your receipt…` then fields → change the merchant → **Confirm** → `Receipt confirmed.`
- `'receipt: take a photo uses the camera input'`: the **Take a photo** control is an `input[type=file][capture=environment]` with `accept` limited to images; `setInputFiles` on it with the same JPEG completes the same flow.
- `'receipt: a sideways phone photo is uploaded upright and smaller'`: upload `receipt-exif-rotated.jpg` (4000×3000 stored, EXIF 6) → `GET /api/files/:id/content` through `page.request` returns a JPEG whose decoded size is portrait with the long side ≤ 2000 px (read the JPEG SOF0 header in the test; no image library).
- `'receipt: a PDF goes up unchanged'`: Task 3's `e-ticket.pdf` through **Choose a file** → the stored file's SHA-256 equals the fixture's.

`registry.spec.ts`: an `APP_PATHS` entry whose `module` is on (all are, in the e2e build) must have a `PAGES` entry. Unchanged rule, now also covering module pages.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run apps/web` → FAIL (component missing).
Run: `npm run test:e2e` (where the browsers are installed) → FAIL (pages missing).

- [ ] **Step 4: Implement**

- `prepareReceiptImage`: for `image/jpeg|png|webp|heic|heif` (or an empty type), `createImageBitmap(file, { imageOrientation: 'from-image' })`; scale so the longest side is at most `maxSide`; draw to an `OffscreenCanvas` (fall back to a `<canvas>`); `convertToBlob({ type: 'image/jpeg', quality })`; return a `File` named like the original with a `.jpg` extension. Any failure, or a PDF, returns the original `File` unchanged. Never throws.
- `FileDropzone`: if `prepare` is given, call it before the size and type checks and before upload. The existing **Take a photo** / **Choose a file** controls (Plan 6 Ruling for Task 13) stay as they are.
- `ReceiptNew`: `FileDropzone` with `prepare={prepareReceiptImage}`; on upload, `requestReading(file.id)` and navigate to `/receipts/:id`.
- `ReceiptCheck`: `useReading`, `FilePreview` of the photo, then `ReceiptReadingFields` with `canConfirm = reading.ownerId === me.id || me.role === 'admin'`. Amount inputs use `inputMode="decimal"` and are parsed with `toPence`; a parse failure shows `Enter an amount like 12.40.`
- Routes, `APP_PATHS` and `NAV` entries appear only when `__HF_MODULES__.includes('ocr')`.

- [ ] **Step 5: Run the tests and the browser gate**

Run: `npx vitest run apps/web` → PASS. `npm run verify` → PASS.
Run: `npm run verify:full` (on the machine with the browsers) → PASS. Open `reports/screenshots/receipt-check-mobile-chromium.png` and `…-mobile-webkit.png`: the "Please check" badges and the Confirm button must be visible without sideways scrolling.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ocr): confirm-or-correct pages; photos prepared in the browser (upright, 2000 px JPEG, HEIC via Safari)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
