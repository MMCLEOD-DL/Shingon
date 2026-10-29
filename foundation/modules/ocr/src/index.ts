export { checkVat, extractReceipt, type OcrLine } from './extract.js';
export { CloudEngineError, UnreadableError, type CloudFailure, type EngineFields, type OcrEngine, type OcrInputType, type OcrResult } from './types.js';
export { createLocalEngine, HEIC_REFUSED, IMAGE_TOO_LARGE, localEngineOptions } from './local.js';
export { readReceipt } from './readReceipt.js';
export { benchCorpus, writeAccuracyReport, type BenchCase, type BenchReport } from './bench.js';
export { checkDestinationAddress, OUTBOUND_DESTINATIONS, RESIDENCY_REGIONS, type OutboundDestination } from './destinations.js';
export { createAzureReceiptEngine, type AzureReceiptOptions } from './azure.js';
export { chooseEngine, OcrPolicyError, type AzureSettings, type ChooseOptions, type EngineMakers, type OcrSettings } from './choose.js';
export { FELL_BACK_WARNING, fallbackMessage, withFallback, type FallbackOptions } from './fallback.js';
