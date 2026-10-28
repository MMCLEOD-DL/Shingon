import type { ConfirmReadingInput, FileView, ReadingView } from '@hf/shared';

export interface ApiIssue { path: string; message: string }

export class ApiError extends Error {
  status: number;
  issues?: ApiIssue[];
  constructor(status: number, message: string, issues?: ApiIssue[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (issues) this.issues = issues;
  }
}

const NETWORK = "Couldn't reach the server. Check your connection and try again.";
const GENERIC = 'Something went wrong. Please try again.';

let unauthorizedHandler: (() => void) | null = null;
/** The auth provider registers this so a 401 from any call signs the person out of the screen. */
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    // Same-origin only: the browser adds the Origin header the server's CSRF check needs.
    res = await fetch(url, { ...init, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, NETWORK);
  }
  if (res.ok) return res;
  let message = GENERIC;
  let issues: ApiIssue[] | undefined;
  try {
    const data = (await res.json()) as { error?: unknown; issues?: unknown };
    // The server's own plain-English text is what people see, including its rate-limit messages.
    if (typeof data.error === 'string' && data.error !== '') message = data.error;
    if (Array.isArray(data.issues)) issues = data.issues as ApiIssue[];
  } catch {
    /* not JSON: keep the generic message */
  }
  if (res.status === 401) unauthorizedHandler?.();
  throw new ApiError(res.status, message, issues);
}

/** A success reply that is not JSON (a proxy's page, a cut-off body) is a failure with the plain message, never a SyntaxError. */
async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text === '' ? undefined : JSON.parse(text);
  } catch {
    throw new ApiError(res.status, GENERIC);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { accept: 'application/json', 'content-type': 'application/json' };
  }
  const res = await send(url, init);
  if (res.status === 204) return undefined as T;
  return (await readJson(res)) as T;
}

export async function uploadFile(file: File): Promise<FileView> {
  const form = new FormData();
  form.append('file', file);
  const res = await send('/api/files', { method: 'POST', body: form, headers: { accept: 'application/json' } });
  return ((await readJson(res)) as { file: FileView }).file;
}

const readingPath = (id: string): string => `/api/readings/${encodeURIComponent(id)}`;

/** Asks for an uploaded file to be read as a receipt. The server wants an empty JSON body. */
export async function requestReading(fileId: string): Promise<ReadingView> {
  return (await api<{ reading: ReadingView }>('POST', `/api/files/${encodeURIComponent(fileId)}/reading`, {})).reading;
}

export async function getReading(id: string): Promise<ReadingView> {
  return (await api<{ reading: ReadingView }>('GET', readingPath(id))).reading;
}

/** The only call that saves a receipt's values: made when the person presses Confirm. */
export async function confirmReading(id: string, input: ConfirmReadingInput): Promise<ReadingView> {
  return (await api<{ reading: ReadingView }>('POST', `${readingPath(id)}/confirm`, input)).reading;
}

export async function getFile(id: string): Promise<FileView> {
  return (await api<{ file: FileView }>('GET', `/api/files/${encodeURIComponent(id)}`)).file;
}
