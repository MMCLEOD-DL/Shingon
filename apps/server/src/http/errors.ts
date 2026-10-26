export class HttpError extends Error {
  readonly status: number;
  readonly userMessage: string;
  readonly issues?: unknown;
  constructor(status: number, userMessage: string, issues?: unknown) {
    super(userMessage);
    this.name = 'HttpError';
    this.status = status;
    this.userMessage = userMessage;
    if (issues !== undefined) this.issues = issues;
  }
  /** Lets Fastify and its plugins treat this as an ordinary HTTP error. */
  get statusCode(): number {
    return this.status;
  }
}

export const unauthorized = (msg = 'Please sign in.') => new HttpError(401, msg);
export const forbidden = (msg = "You don't have permission to do that.") => new HttpError(403, msg);
export const notFound = (msg = "We couldn't find that.") => new HttpError(404, msg);
export const badRequest = (msg: string, issues?: unknown) => new HttpError(400, msg, issues);
export const tooLarge = (msg = 'That file is too large.') => new HttpError(413, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
