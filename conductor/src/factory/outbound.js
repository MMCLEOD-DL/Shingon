// Outside services a project may send data to (Contract 7 §7.4). `policy.outbound` holds ids from
// this list, never free text, so later plans can match on ids and hosts. A plan that needs a new
// service adds its id here; nothing else in the factory keeps a list of services.

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const OUTBOUND_SERVICES = deepFreeze({
  'cloudflare-tunnel': { label: 'Cloudflare Tunnel', hosts: ['*.cloudflare.com', '*.argotunnel.com'], carries: "the app's web traffic" },
  'azure-document-intelligence': { label: 'Azure Document Intelligence', hosts: ['*.cognitiveservices.azure.com'], carries: 'receipt images' },
});

export function outboundProblems(ids) {
  if (!Array.isArray(ids)) return ['"outbound" must be a list of the outside services data may go to (an empty list means none).'];
  const problems = [];
  const counts = new Map();
  const known = Object.keys(OUTBOUND_SERVICES).join(', ');
  for (const id of ids) {
    if (typeof id !== 'string' || !Object.hasOwn(OUTBOUND_SERVICES, id)) {
      problems.push(`${JSON.stringify(id)} is not an outside service Conductor knows (known: ${known}). Leave it out, or have it added to Conductor's list first.`);
    } else counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of counts) if (n > 1) problems.push(`"${id}" is listed twice in "outbound".`);
  return problems;
}
