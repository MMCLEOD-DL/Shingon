// A complete, fictional brief (Thistle Joinery's expenses app) used across the brief tests.
export function validBrief(over = {}) {
  return {
    schema: 1,
    client: 'Thistle Joinery Ltd',
    purpose: 'Staff photograph receipts on their phones, managers approve them, and the finance lead gets a monthly expenses spreadsheet with VAT split out.',
    kind: 'web-app',
    roles: [
      { name: 'Staff', whatTheyDo: 'Upload receipts and claim them back', sees: 'Only their own claims', mapsTo: 'member' },
      { name: 'Manager', whatTheyDo: 'Approve or reject claims from their team', sees: "Their team's claims", mapsTo: 'manager' },
      { name: 'Finance', whatTheyDo: 'Run the monthly report and manage users', sees: 'All claims', mapsTo: 'admin' },
    ],
    records: [{ name: 'Claim', description: 'One receipt claimed back by one person', holdsFiles: true, personalData: true }],
    features: [
      { id: 'upload-receipt', title: 'Upload a receipt', story: 'A member of staff photographs a receipt and fills in the amount, VAT and category.', roles: ['Staff'], data: ['Claim'],
        acceptance: [{ given: 'Alice is signed in as Staff', when: 'she uploads a £12.40 receipt with £2.07 VAT dated 3 March 2026, category Travel', then: 'her claims list shows Travel £12.40 dated 3 March 2026, status Waiting' }] },
      { id: 'monthly-report', title: 'Monthly expenses report', story: 'Finance downloads a spreadsheet of approved claims for one month, with VAT split out.', roles: ['Finance'], data: ['Claim'],
        acceptance: [{ given: "Alice's £12.40 Travel claim with £2.07 VAT was approved in March 2026", when: 'Finance downloads the March 2026 report', then: 'the Travel row shows net £10.33, VAT £2.07, gross £12.40' }] },
    ],
    outputs: [{ name: 'Monthly expenses report', format: 'xlsx', roles: ['Finance'], description: 'Approved claims for one month, one row per claim, totals by category' }],
    integrations: [],
    modules: ['ocr', 'xlsx-export'],
    policy: {
      hosting: 'client-box', outbound: [], residency: 'uk',
      retention: { text: 'Claims and receipts are kept for 6 years, then deleted', days: 2190 },
      backupDestination: { kind: 'client-owned', detail: "A USB disk kept in the client's office safe" },
      operatorAccess: true,
    },
    assumptions: ['All receipts are in pounds sterling'],
    openQuestions: [],
    ...over,
  };
}

// What Conductor writes at approval: example ids (Task 2's assignExampleIds output for a first version) plus the meta fields.
export function approvedBrief(over = {}) {
  const b = validBrief();
  return { ...b,
    features: b.features.map((f) => ({ ...f, acceptance: f.acceptance.map((ex, i) => ({ id: `${f.id}#${i + 1}`, ...ex })) })),
    exampleSeq: { 'upload-receipt': 1, 'monthly-report': 1 },
    slug: 'thistle', version: 1, createdAt: '2026-10-27T09:00:00.000Z', revisedFrom: null,
    approvedAt: '2026-10-27T10:00:00.000Z', approvedBy: 'Malcolm', ...over };
}
