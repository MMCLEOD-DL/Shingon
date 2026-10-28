import type { Residency } from '@hf/shared';

/** A place outside the box that receipts may be sent to, if the app's data policy (`policy.outbound`) lists its id. */
export interface OutboundDestination {
  readonly id: string;
  readonly hosts: readonly string[];
  readonly carries: string;
}

/**
 * Every outbound destination this module can use. The id and hosts mirror Conductor's
 * `OUTBOUND_SERVICES['azure-document-intelligence']` (Plan 7 `src/factory/outbound.js`, Contract 7.4), which a
 * brief's `policy.outbound` is checked against: if either side changes, both change together.
 */
export const OUTBOUND_DESTINATIONS: readonly OutboundDestination[] = [
  { id: 'azure-document-intelligence', hosts: ['*.cognitiveservices.azure.com'], carries: 'receipt photos and PDFs, for reading' },
];

/**
 * The Azure regions each residency allows. Switzerland and Norway are not in the EU but have UK adequacy; the
 * operator can trim this list.
 */
export const RESIDENCY_REGIONS: { readonly [R in Residency]: R extends 'any' ? 'any' : readonly string[] } = {
  uk: ['uksouth', 'ukwest'],
  'uk-eu': ['uksouth', 'ukwest', 'northeurope', 'westeurope', 'francecentral', 'germanywestcentral', 'swedencentral', 'switzerlandnorth', 'norwayeast', 'italynorth', 'polandcentral', 'spaincentral'],
  any: 'any',
};
