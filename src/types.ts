import type {
  BucketVisibility,
  FileCategory,
  FileSortBy,
  PresignFailureReason,
  ThumbnailStatus,
} from "./enums.js";

// ---------------------------------------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------------------------------------

/** A `fetch`-compatible function. Defaults to the runtime's global `fetch`. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Passed to {@link NinjaVaultCdnHooks.onRequest} just before a request is sent. */
export interface CdnRequestContext {
  /** HTTP method, e.g. `GET`. */
  readonly method: string;
  /** Absolute request URL. */
  readonly url: string;
  /** Request headers with the `X-Api-Key` value replaced by `[REDACTED]`. Safe to log. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Adds or replaces a header on the outgoing request (for example `X-Correlation-Id`). The API key header
   * cannot be changed this way.
   */
  setHeader(name: string, value: string): void;
}

/** Passed to {@link NinjaVaultCdnHooks.onResponse} when the server answered (any status code). */
export interface CdnResponseContext {
  readonly method: string;
  readonly url: string;
  /** Request headers, API key redacted. */
  readonly headers: Readonly<Record<string, string>>;
  /** HTTP status code of the response. */
  readonly status: number;
  /** Time from sending the request until the response headers arrived, in milliseconds. */
  readonly durationMs: number;
}

/** Passed to {@link NinjaVaultCdnHooks.onError} when a call fails (API error, timeout, abort or network). */
export interface CdnErrorContext {
  readonly method: string;
  readonly url: string;
  /** Request headers, API key redacted. */
  readonly headers: Readonly<Record<string, string>>;
  /** HTTP status code, when the server answered. */
  readonly status: number | undefined;
  /** Time since the request was sent, in milliseconds. */
  readonly durationMs: number;
  /** The error that is about to be thrown to the caller. */
  readonly error: unknown;
}

/**
 * Optional callbacks for logging, metrics and correlation. Hooks may be async; they are awaited. An error
 * thrown by a hook is swallowed so that logging can never break a CDN call.
 */
export interface NinjaVaultCdnHooks {
  onRequest?: ((context: CdnRequestContext) => void | Promise<void>) | undefined;
  onResponse?: ((context: CdnResponseContext) => void | Promise<void>) | undefined;
  onError?: ((context: CdnErrorContext) => void | Promise<void>) | undefined;
}

/** Options for {@link NinjaVaultCdnClient}. Every setting falls back to an environment variable. */
export interface NinjaVaultCdnClientOptions {
  /**
   * Base URL of the authenticated `/api/v1/...` routes, e.g. `https://cdn.example.com`. A path prefix works
   * (`https://gateway.example.com/cdn`). Falls back to `NINJAVAULT_CDN_BASE_URL`.
   */
  baseUrl?: string | undefined;
  /** The `X-Api-Key` issued for your integration. Backend-only secret. Falls back to `NINJAVAULT_CDN_API_KEY`. */
  apiKey?: string | undefined;
  /**
   * Host used by {@link NinjaVaultCdnClient.buildPublicUrl}; the client appends `/public/`. Defaults to
   * `baseUrl`. Falls back to `NINJAVAULT_CDN_PUBLIC_BASE_URL`.
   */
  publicBaseUrl?: string | undefined;
  /**
   * Per-request timeout in milliseconds, until the response headers (and, for JSON calls, the body) have
   * arrived. Downloads are not cut off once streaming has started. Default `30000`. `0` disables it.
   */
  timeoutMs?: number | undefined;
  /** Custom `fetch` implementation (for tests, proxies or instrumentation). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike | undefined;
  /** Logging / correlation callbacks. */
  hooks?: NinjaVaultCdnHooks | undefined;
  /** Overrides the `User-Agent` header. Default `ninjavault-cdn-node/<version>`. */
  userAgent?: string | undefined;
}

/** Per-call options accepted as the last argument of every async client method. */
export interface RequestOptions {
  /** Cancels the call. Aborting rejects with the signal's reason (a standard `AbortError` by default). */
  signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------

/**
 * Result of `GET /api/v1/me`. Empty {@link allowedBuckets} / {@link allowedTenantIds} mean *unrestricted*,
 * not "no access".
 */
export interface AccessContext {
  name: string;
  isUnrestricted: boolean;
  isAdmin: boolean;
  allowedBuckets: string[];
  /** Tenant ids the key is scoped to (numeric ids or GUIDs, as strings). */
  allowedTenantIds: string[];
  buckets: AccessBucket[];
}

export interface AccessBucket {
  name: string;
  visibility: BucketVisibility;
}

export interface Bucket {
  name: string;
  visibility: BucketVisibility;
  /** Live files visible to the API key (a tenant-scoped key sees only its own). */
  fileCount: number;
  totalSizeBytes: number;
}

/**
 * Result of a successful upload. Smaller than {@link FileObject}; call `getMetadata` for the full detail.
 * Persist {@link bucket} + {@link objectKey}: the object key, not the file name, identifies the file.
 */
export interface UploadResult {
  id: string;
  bucket: string;
  objectKey: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  visibility: BucketVisibility;
  /** Public URL for public buckets; the API-key-gated route for private ones. */
  url: string;
  /** Inline-rendering URL (`?disposition=inline`) for public files, otherwise `null`. */
  viewUrl: string | null;
}

/** Full file detail returned by the list and metadata routes. */
export interface FileObject {
  id: string;
  /** Tenant id as a string (numeric id or GUID). */
  tenantId: string;
  ownerId: number | null;
  bucket: string;
  objectKey: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  /** SHA-256 of the stored bytes (lowercase hex); also served as the download `ETag`. */
  checksum: string | null;
  visibility: BucketVisibility;
  /** Lowercase extension without the dot, or `null`. */
  extension: string | null;
  category: FileCategory;
  thumbnailStatus: ThumbnailStatus;
  /** Short-lived presigned thumbnail link, present only when `thumbnailStatus` is `Ready`. */
  thumbnailUrl: string | null;
  createdAtUtc: Date;
  /** Public URL for public buckets; the API-key-gated route for private ones. */
  url: string;
  /** Inline-rendering URL for public files, otherwise `null`. */
  viewUrl: string | null;
}

export interface PagedResult<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface FileSummary {
  totalFileCount: number;
  totalSizeBytes: number;
  categories: FileCategorySummary[];
}

export interface FileCategorySummary {
  category: FileCategory;
  fileCount: number;
  totalSizeBytes: number;
}

export interface PresignedUrl {
  /** Anonymous download URL, safe to hand to a browser or mobile app until it expires. */
  url: string;
  expiresAtUtc: Date;
}

export interface PresignedTarget {
  bucket: string;
  objectKey: string;
  url: string;
  expiresAtUtc: Date;
}

export interface PresignFailure {
  bucket: string;
  objectKey: string;
  reason: PresignFailureReason;
}

/** Batch presign answers HTTP 200 even when some targets fail: always inspect {@link failed}. */
export interface PresignBatchResult {
  succeeded: PresignedTarget[];
  failed: PresignFailure[];
}

/** A streamed download. The body is not buffered; read it once (stream it, or call `arrayBuffer`/`text`). */
export interface FileDownload {
  /** The response body as a web `ReadableStream`. */
  readonly body: ReadableStream<Uint8Array>;
  /** Media type from `Content-Type` (without parameters), or `null`. */
  readonly contentType: string | null;
  /** File name from `Content-Disposition` (`filename*` preferred over `filename`), or `null`. */
  readonly fileName: string | null;
  /** `Content-Length`, or `null` when the server streams without one. */
  readonly sizeBytes: number | null;
  /** `ETag` header (the file checksum in quotes), or `null`. */
  readonly etag: string | null;
  /** Reads the whole body into memory. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Reads the whole body as UTF-8 text. */
  text(): Promise<string>;
}

// ---------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------

/** File content accepted by `upload`. In Node use `fs.openAsBlob(path)` (Node >= 19.8) or `fs.readFile`. */
export type UploadBody = Blob | ArrayBuffer | ArrayBufferView;

/**
 * Upload request. The bucket must exist and be allowed for the API key; `tenantId` must be inside the key's
 * tenant scope. The server enforces `folderPath` rules (max 8 `/`-separated segments of
 * `[A-Za-z0-9][A-Za-z0-9_-]*`), a content-type allow-list and a maximum size; violations fail with 40001.
 */
export interface UploadRequest {
  bucket: string;
  /** Tenant to store the file under: a positive integer (e.g. `42`) or a GUID. */
  tenantId: string | number | bigint;
  file: UploadBody;
  /** Original file name sent in the multipart `File` part. */
  fileName: string;
  /** MIME type of the file, e.g. `application/pdf`. Defaults to the Blob's own type, if any. */
  contentType?: string | undefined;
  ownerId?: number | bigint | string | undefined;
  /** Optional sub-folder, e.g. `reports/2026`. */
  folderPath?: string | undefined;
}

/** Filters for `listFiles`. Every field is optional; omitted fields use the server defaults. */
export interface FileListQuery {
  bucket?: string | undefined;
  tenantId?: string | number | bigint | undefined;
  ownerId?: number | bigint | string | undefined;
  /** Matches the start of the object key (the nearest thing to a folder path). */
  objectKeyPrefix?: string | undefined;
  /** Case-insensitive substring match on the original file name. */
  fileNameContains?: string | undefined;
  contentType?: string | undefined;
  category?: FileCategory | undefined;
  visibility?: BucketVisibility | undefined;
  /** Sent as ISO-8601 UTC (`createdFromUTC`). */
  createdFromUtc?: Date | string | undefined;
  /** Sent as ISO-8601 UTC (`createdToUTC`). */
  createdToUtc?: Date | string | undefined;
  /** Return soft-deleted files instead of live ones. Server default `false`. */
  includeDeleted?: boolean | undefined;
  /** Server default `CreatedAtUTC`. */
  sortBy?: FileSortBy | undefined;
  /** Server default `true`. */
  sortDescending?: boolean | undefined;
  /** 1-based. Server default `1`. */
  page?: number | undefined;
  /** 1 to 200. Server default `50`. */
  pageSize?: number | undefined;
}

/**
 * Leave `expirySeconds` unset to use the server default (300 s by default). The server clamps it to its
 * configured maximum (3600 s by default).
 */
export interface PresignRequest {
  bucket: string;
  objectKey: string;
  expirySeconds?: number | undefined;
}

export interface PresignTarget {
  bucket: string;
  objectKey: string;
}

/** At most 200 targets per batch (server limit). One expiry applies to the whole batch. */
export interface PresignBatchRequest {
  targets: readonly PresignTarget[];
  expirySeconds?: number | undefined;
}
