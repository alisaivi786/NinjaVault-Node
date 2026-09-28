/** CDN error codes returned in the error envelope's `errorCode` field. */
export const ErrorCode = {
  /** 400: validation failed (folder path, content type, file size, ...). See `details`. */
  ValidationFailed: 40001,
  /** 401: API key missing, mistyped or revoked. */
  Unauthorized: 40101,
  /** 403: key not allowed for this bucket or tenant. */
  Forbidden: 40301,
  /** 404: bucket or object key not found. */
  NotFound: 40401,
  /** 409: quota exceeded or conflicting state. */
  Conflict: 40901,
  /** 429: rate limited. Wait for `retryAfterMs`. */
  TooManyRequests: 42901,
  /** 500: unexpected server error. */
  InternalServerError: 50001,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Fields used to construct a {@link CdnApiError}. */
export interface CdnApiErrorInit {
  statusCode: number;
  errorCode?: number | undefined;
  description?: string | undefined;
  correlationId?: string | undefined;
  details?: Record<string, string[]> | undefined;
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

/** Thrown for every failed CDN call: non-2xx responses, `success: false` envelopes and invalid bodies. */
export class CdnApiError extends Error {
  override readonly name: string = "CdnApiError";
  /** HTTP status code (`0` when no response was received, e.g. {@link CdnTimeoutError}). */
  readonly statusCode: number;
  /** CDN error code from the envelope, see {@link ErrorCode}. */
  readonly errorCode: number | undefined;
  /** Longer explanation from the envelope, or the raw body when the server did not send an envelope. */
  readonly description: string | undefined;
  /** Server trace id for the failed request (envelope `traceId`). Log it and send it to the CDN team. */
  readonly correlationId: string | undefined;
  /** Field-level validation errors, e.g. `{ FolderPath: ["..."] }`. */
  readonly details: Record<string, string[]> | undefined;
  /** How long the server asked you to wait (from `Retry-After`), in milliseconds. Usually set on 429. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, init: CdnApiErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.statusCode = init.statusCode;
    this.errorCode = init.errorCode;
    this.description = init.description;
    this.correlationId = init.correlationId;
    this.details = init.details;
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** Thrown when a call exceeds the client's `timeoutMs`. A subclass of {@link CdnApiError} with `statusCode` 0. */
export class CdnTimeoutError extends CdnApiError {
  override readonly name: string = "CdnTimeoutError";
  /** The timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, method: string, url: string) {
    super(`CDN request ${method} ${url} timed out after ${timeoutMs} ms.`, { statusCode: 0 });
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when a required setting (base URL, API key) is missing or invalid. */
export class CdnConfigurationError extends Error {
  override readonly name: string = "CdnConfigurationError";
  /** The option name that is missing or invalid, e.g. `apiKey`. */
  readonly setting: string;

  constructor(setting: string, message: string) {
    super(message);
    this.setting = setting;
  }
}
