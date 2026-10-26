import type { FileView } from '@hf/shared';

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

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { accept: 'application/json', 'content-type': 'application/json' };
  }
  const res = await send(url, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export async function uploadFile(file: File): Promise<FileView> {
  const form = new FormData();
  form.append('file', file);
  const res = await send('/api/files', { method: 'POST', body: form, headers: { accept: 'application/json' } });
  return ((await res.json()) as { file: FileView }).file;
}
