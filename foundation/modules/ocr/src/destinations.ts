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

const SCHEME_REFUSED = (setting: string): string => `${setting} must start with https://.`;
const ADDRESS_REFUSED = (setting: string, suffix: string): string =>
  `${setting} must be an Azure Document Intelligence address ending in .${suffix}, with no port, path or query, like https://name.${suffix}.`;

/** Whether a lower-case host name matches a destination host: "*.x" needs at least one label before ".x". */
function hostMatches(host: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return host === pattern;
  const suffix = pattern.slice(1);
  if (!host.endsWith(suffix)) return false;
  const labels = host.slice(0, -suffix.length);
  return labels !== '' && labels.split('.').every((l) => /^[a-z0-9-]+$/.test(l));
}

/**
 * Checks the address receipts would be sent to against a destination's hosts. It returns the address's origin, or
 * the one plain sentence saying why it is refused (never repeating the address, which may carry a key). The only
 * exception is `http://127.0.0.1` when `allowHttpLoopback` is set, for the test stand-in.
 */
export function checkDestinationAddress(
  setting: string, address: string, destinationId: string, allowHttpLoopback = false,
): { ok: true; origin: string } | { ok: false; problem: string } {
  const destination = OUTBOUND_DESTINATIONS.find((d) => d.id === destinationId);
  const suffix = destination?.hosts[0]?.replace(/^\*\./, '') ?? '';
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return { ok: false, problem: SCHEME_REFUSED(setting) };
  }
  const loopback = allowHttpLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopback) return { ok: false, problem: SCHEME_REFUSED(setting) };
  const plain = url.username === '' && url.password === '' && url.search === '' && url.hash === '' && !/[?#]/.test(address)
    && url.pathname === '/' && (loopback || url.port === '');
  const host = url.hostname.toLowerCase();
  if (!plain || !(loopback || (destination?.hosts.some((h) => hostMatches(host, h)) ?? false))) {
    return { ok: false, problem: ADDRESS_REFUSED(setting, suffix) };
  }
  return { ok: true, origin: url.origin };
}
