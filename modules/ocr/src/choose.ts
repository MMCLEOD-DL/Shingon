/**
 * Which reader the app uses (spec §6). Receipts are read on the box unless the committed data policy allows
 * Azure Document Intelligence, the box's region fits the policy's residency, and the box's `.env` asks for it.
 * Anything else stops the app at start, one plain sentence per problem, before any cloud engine exists, so a
 * configuration mistake can never send a receipt off the box (Review Focus 3).
 */
import type { AppProfile } from '@hf/shared';
import { checkDestinationAddress, RESIDENCY_REGIONS } from './destinations.js';
import { withFallback, type FallbackOptions } from './fallback.js';
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
  azure: (cfg: AzureSettings & { allowHttpLoopback: boolean }) => OcrEngine;
}

export interface ChooseOptions extends FallbackOptions {
  /** Lets `http://127.0.0.1` through as the Azure endpoint. For the test stand-in only; never set in production. */
  allowHttpLoopback?: boolean;
}

const orList = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1) ?? ''}`);
const RESIDENCY_WORDS = { uk: 'the UK', 'uk-eu': 'the UK or Europe' } as const;

function azureProblems(profile: AppProfile, azure: Partial<AzureSettings> | undefined, allowHttpLoopback: boolean): string[] {
  const problems: string[] = [];
  if (!profile.policy.outbound.includes(AZURE_ID)) {
    problems.push("OCR_ENGINE is set to azure, but this app's data policy does not allow receipts to be sent to Azure Document Intelligence. Use OCR_ENGINE=local, or change the policy through a change request.");
  }
  const given = (k: keyof AzureSettings): string => azure?.[k]?.trim() ?? '';
  for (const k of ['endpoint', 'key', 'region'] as const) {
    if (given(k) === '') problems.push(`OCR_AZURE_${k.toUpperCase()} is needed when OCR_ENGINE is azure.`);
  }
  const endpoint = given('endpoint');
  if (endpoint !== '') {
    const checked = checkDestinationAddress('OCR_AZURE_ENDPOINT', endpoint, AZURE_ID, allowHttpLoopback);
    if (!checked.ok) problems.push(checked.problem);
  }
  // The region is what the operator declares for the Azure resource; it is not detected from the service.
  const region = given('region');
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
export async function chooseEngine(profile: AppProfile, cfg: OcrSettings, make: EngineMakers, opts: ChooseOptions = {}): Promise<OcrEngine> {
  const allowHttpLoopback = opts.allowHttpLoopback ?? false;
  const engine: string = cfg.engine;
  if (engine === 'local') return make.local();
  if (engine !== 'azure') throw new OcrPolicyError(['OCR_ENGINE must be local or azure.']);

  const problems = azureProblems(profile, cfg.azure, allowHttpLoopback);
  if (problems.length > 0 || !cfg.azure) throw new OcrPolicyError(problems);

  const local = await make.local();
  let cloud: OcrEngine;
  try {
    cloud = make.azure({ ...cfg.azure, allowHttpLoopback });
  } catch (err) {
    await local.close();
    throw err;
  }
  return withFallback(cloud, local, { ...(opts.onFallback ? { onFallback: opts.onFallback } : {}) });
}
