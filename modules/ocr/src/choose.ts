/**
 * Which reader the app uses (spec §6). Receipts are read on the box unless the committed data policy allows
 * Azure Document Intelligence, the box's region fits the policy's residency, and the box's `.env` asks for it.
 * Anything else stops the app at start, one plain sentence per problem, before any cloud engine exists, so a
 * configuration mistake can never send a receipt off the box (Review Focus 3).
 */
import type { AppProfile } from '@hf/shared';
import { RESIDENCY_REGIONS } from './destinations.js';
import { withFallback } from './fallback.js';
import type { OcrEngine } from './types.js';

const AZURE_ID = 'azure-document-intelligence';

/** The box's receipt-reading settings: the shape of the server's `Config['ocr']`. */
export interface OcrSettings {
  engine: 'local' | 'azure';
  concurrency: number;
  timeoutMs: number;
  azure?: AzureSettings;
}
export interface AzureSettings { endpoint: string; key: string; region: string }

/** Why the app won't start with these receipt-reading settings. The sentences never hold the key or the endpoint. */
export class OcrPolicyError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'OcrPolicyError';
    this.problems = problems;
  }
}

export interface EngineMakers {
  local: () => Promise<OcrEngine>;
  azure: (cfg: AzureSettings) => OcrEngine;
}

const orList = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1) ?? ''}`);
const RESIDENCY_WORDS = { uk: 'the UK', 'uk-eu': 'the UK or Europe' } as const;

function azureProblems(profile: AppProfile, azure: Partial<AzureSettings> | undefined): string[] {
  const problems: string[] = [];
  if (!profile.policy.outbound.includes(AZURE_ID)) {
    problems.push("OCR_ENGINE is set to azure, but this app's data policy does not allow receipts to be sent to Azure Document Intelligence. Use OCR_ENGINE=local, or change the policy through a change request.");
  }
  const missing = (['endpoint', 'key', 'region'] as const).filter((k) => !azure?.[k]);
  for (const k of missing) problems.push(`OCR_AZURE_${k.toUpperCase()} is needed when OCR_ENGINE is azure.`);
  const region = azure?.region;
  const residency = profile.policy.residency;
  if (region && residency !== 'any') {
    const allowed = RESIDENCY_REGIONS[residency];
    if (!allowed.includes(region)) {
      // The config only lets lower-case letters and digits through; anything else is not repeated back.
      const shown = /^[a-z0-9]{1,40}$/.test(region) ? region : 'not an allowed region';
      problems.push(`OCR_AZURE_REGION is ${shown}, but this app's data must stay in ${RESIDENCY_WORDS[residency]}. Use ${orList(allowed)}.`);
    }
  }
  return problems;
}

/**
 * The engine the app reads receipts with. Local needs no permission. Azure is made only when nothing is wrong, and
 * then always with the local engine as its fallback.
 */
export async function chooseEngine(profile: AppProfile, cfg: OcrSettings, make: EngineMakers): Promise<OcrEngine> {
  const engine: string = cfg.engine;
  if (engine === 'local') return make.local();
  if (engine !== 'azure') throw new OcrPolicyError(['OCR_ENGINE must be local or azure.']);

  const problems = azureProblems(profile, cfg.azure);
  if (problems.length > 0 || !cfg.azure) throw new OcrPolicyError(problems);

  const local = await make.local();
  let cloud: OcrEngine;
  try {
    cloud = make.azure(cfg.azure);
  } catch (err) {
    await local.close();
    throw err;
  }
  return withFallback(cloud, local);
}
