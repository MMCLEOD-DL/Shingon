// The sample brief shared by the full-council tests, in Contract 7.4's shapes.
// Example ids are stable and not positional: mileage-claims has #1, #2 and #4 (an earlier #3 was removed in a revision).
export const BRIEF = Object.freeze({
  schema: 1,
  client: 'Acme Ltd',
  kind: 'web-app',
  features: [
    { id: 'mileage-claims', title: 'Mileage claims', acceptance: [
      { id: 'mileage-claims#1', given: 'a member', when: 'they claim 120 miles', then: 'the claim is £54.00 at 45p a mile' },
      { id: 'mileage-claims#2', given: 'a manager', when: 'they open March', then: "they see their team's claims only" },
      { id: 'mileage-claims#4', given: 'a claim of 0 miles', when: 'it is saved', then: 'it is refused' },
    ] },
    { id: 'receipts', title: 'Receipts', acceptance: [] },
  ],
  policy: { hosting: 'client-box', outbound: ['cloudflare-tunnel'], residency: 'uk', retention: { text: 'six years', days: 2190 },
    backupDestination: { kind: 'client-owned', detail: 'the office NAS' }, operatorAccess: true },
});
