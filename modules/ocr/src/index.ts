export { checkVat, extractReceipt, type OcrLine } from './extract.js';
export { UnreadableError, type EngineFields, type OcrEngine, type OcrInputType, type OcrResult } from './types.js';
export { createLocalEngine, localEngineOptions } from './local.js';
export { readReceipt } from './readReceipt.js';
export { benchCorpus, writeAccuracyReport, type BenchCase, type BenchReport } from './bench.js';
