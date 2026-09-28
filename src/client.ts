import { CdnApiError, CdnConfigurationError, CdnTimeoutError } from "./errors.js";
import {
  buildQuery,
  encodeObjectKey,
  encodePathSegment,
  escapeDataString,
  isBlank,
  joinUrl,
  parseContentDispositionFileName,
  parseLength,
  parseMediaType,
  parseRetryAfter,
  readEnv,
  requireNonBlank,
} from "./internal/http.js";
import {
  mapAccessContext,
  mapBuckets,
  mapFileObject,
  mapFileSummary,
  mapPagedFiles,
  mapPresignBatchResult,
  mapPresignedUrl,
  mapUploadResult,
  mapWireError,
  type WireError,
} from "./internal/mappers.js";
import type {
  AccessContext,
  Bucket,
  FetchLike,
  FileDownload,
  FileListQuery,
  FileObject,
  FileSummary,
  NinjaVaultCdnClientOptions,
  NinjaVaultCdnHooks,
  PagedResult,
  PresignBatchRequest,
  PresignBatchResult,
  PresignedUrl,
  PresignRequest,
  PresignTarget,
  RequestOptions,
  UploadBody,
  UploadRequest,
  UploadResult,
} from "./types.js";
import { SDK_VERSION } from "./version.js";

/** Environment variables read when the matching option is not passed. */
export const ENV_BASE_URL = "NINJAVAULT_CDN_BASE_URL";
export const ENV_API_KEY = "NINJAVAULT_CDN_API_KEY";
export const ENV_PUBLIC_BASE_URL = "NINJAVAULT_CDN_PUBLIC_BASE_URL";

const API_KEY_HEADER = "X-Api-Key";
const REDACTED = "[REDACTED]";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RAW_ERROR_BODY = 2_000;

type HttpMethod = "GET" | "POST" | "DELETE";

interface SendInit {
  method: HttpMethod;
  path: string;
  body?: BodyInit | undefined;
  json?: unknown;
  accept?: string | undefined;
  /** Keep the request linked to the caller's signal after headers arrive (streaming downloads). */
  streaming?: boolean | undefined;
}

interface Envelope {
  success: boolean;
  data: unknown;
  error: WireError | undefined;
}

const now: () => number =
  typeof globalThis.performance?.now === "function" ? () => globalThis.performance.now() : () => Date.now();

function validateUrl(value: string | undefined, setting: string): string | undefined {
  if (value === undefined || isBlank(value)) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CdnConfigurationError(
      setting,
      `NinjaVault CDN ${setting} "${value}" is not a valid absolute URL.`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CdnConfigurationError(setting, `NinjaVault CDN ${setting} must use http or https.`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new CdnConfigurationError(
      setting,
      `NinjaVault CDN ${setting} must not contain a query or fragment.`,
    );
  }
  return value.trim();
}

function redact(headers: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    copy[name] = name.toLowerCase() === API_KEY_HEADER.toLowerCase() ? REDACTED : value;
  }
  return copy;
}

async function safeHook<T>(
  hook: ((context: T) => void | Promise<void>) | undefined,
  context: T,
): Promise<void> {
  if (hook === undefined) {
    return;
  }
  try {
    await hook(context);
  } catch {
    // Logging must never break a CDN call.
  }
}

function isBlobLike(value: unknown): value is Blob {
  return (
    typeof Blob !== "undefined" &&
    (value instanceof Blob ||
      (typeof value === "object" &&
        value !== null &&
        typeof (value as Blob).arrayBuffer === "function" &&
        typeof (value as Blob).size === "number" &&
        typeof (value as Blob).slice === "function"))
  );
}

function toBlob(file: UploadBody, contentType: string | undefined): Blob {
  if (isBlobLike(file)) {
    if (contentType === undefined || file.type === contentType) {
      return file;
    }
    // slice() re-types the Blob without copying its bytes (works for fs.openAsBlob too).
    return file.slice(0, file.size, contentType);
  }
  const options = contentType === undefined ? undefined : { type: contentType };
  if (file instanceof ArrayBuffer) {
    return new Blob([file], options);
  }
  if (ArrayBuffer.isView(file)) {
    const view = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    return new Blob([view as Uint8Array<ArrayBuffer>], options);
  }
  throw new TypeError("file must be a Blob, ArrayBuffer or Uint8Array.");
}

function idText(value: string | number | bigint, name: string): string {
  if (typeof value === "string") {
    return requireNonBlank(value, name).trim();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number.`);
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  throw new TypeError(`${name} must be a string, number or bigint.`);
}

function parseEnvelope(text: string): Envelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.success !== "boolean") {
    return undefined;
  }
  return { success: raw.success, data: raw.data, error: mapWireError(raw.error) };
}

function envelopeError(envelope: Envelope, response: Response): CdnApiError {
  const error = envelope.error;
  return new CdnApiError(error?.message ?? "CDN request failed.", {
    statusCode: response.status,
    errorCode: error?.errorCode,
    description: error?.description,
    correlationId: error?.traceId,
    details: error?.details,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
  });
}

/**
 * Server-to-server client for the NinjaVault CDN Server, authenticated with an `X-Api-Key`.
 *
 * Never expose the API key to browsers or mobile apps: hand them {@link buildPublicUrl} links for public
 * buckets, or {@link createPresignedUrl} / {@link createPresignedUrls} links for private files.
 */
export class NinjaVaultCdnClient {
  /** The SDK version, also sent in the `User-Agent` header. */
  static readonly version: string = SDK_VERSION;

  readonly #baseUrl: string | undefined;
  readonly #apiKey: string | undefined;
  readonly #publicBaseUrl: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike | undefined;
  readonly #hooks: NinjaVaultCdnHooks;
  readonly #userAgent: string;

  constructor(options: NinjaVaultCdnClientOptions = {}) {
    this.#baseUrl = validateUrl(options.baseUrl ?? readEnv(ENV_BASE_URL), "baseUrl");
    this.#publicBaseUrl = validateUrl(options.publicBaseUrl ?? readEnv(ENV_PUBLIC_BASE_URL), "publicBaseUrl");
    const apiKey = options.apiKey ?? readEnv(ENV_API_KEY);
    this.#apiKey = apiKey === undefined || isBlank(apiKey) ? undefined : apiKey.trim();

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new CdnConfigurationError("timeoutMs", "NinjaVault CDN timeoutMs must be a number >= 0.");
    }
    this.#timeoutMs = timeoutMs;

    const customFetch = options.fetch;
    this.#fetch =
      customFetch ??
      (typeof globalThis.fetch === "function"
        ? (input: string, init: RequestInit) => globalThis.fetch(input, init)
        : undefined);
    this.#hooks = options.hooks ?? {};
    this.#userAgent = isBlank(options.userAgent) ? `ninjavault-cdn-node/${SDK_VERSION}` : options.userAgent;
  }

  /** The resolved base URL, or `undefined` when not configured. */
  get baseUrl(): string | undefined {
    return this.#baseUrl;
  }

  /** Validates the API key and returns its tenant/bucket scope. Call once at startup. `GET /api/v1/me` */
  async getAccessContext(options?: RequestOptions): Promise<AccessContext> {
    return mapAccessContext(await this.#sendJson({ method: "GET", path: "/api/v1/me" }, options));
  }

  /** Lists buckets visible to the API key, with visibility and usage counters. `GET /api/v1/buckets` */
  async listBuckets(options?: RequestOptions): Promise<Bucket[]> {
    return mapBuckets(await this.#sendJson({ method: "GET", path: "/api/v1/buckets" }, options));
  }

  /**
   * Uploads a file as `multipart/form-data`. Persist the returned `bucket` + `objectKey`; the object key,
   * not the original file name, is what fetches the file later. `POST /api/v1/files`
   */
  async upload(request: UploadRequest, options?: RequestOptions): Promise<UploadResult> {
    if (typeof request !== "object" || request === null) {
      throw new TypeError("request is required.");
    }
    const bucket = requireNonBlank(request.bucket, "bucket");
    const fileName = requireNonBlank(request.fileName, "fileName");
    if (request.tenantId === undefined || request.tenantId === null) {
      throw new TypeError("tenantId is required.");
    }
    if (request.file === undefined || request.file === null) {
      throw new TypeError("file is required.");
    }
    const contentType = isBlank(request.contentType) ? undefined : request.contentType.trim();

    const form = new FormData();
    form.append("Bucket", bucket);
    form.append("TenantId", idText(request.tenantId, "tenantId"));
    if (request.ownerId !== undefined && request.ownerId !== null) {
      form.append("OwnerId", idText(request.ownerId, "ownerId"));
    }
    if (!isBlank(request.folderPath)) {
      form.append("FolderPath", request.folderPath);
    }
    form.append("File", toBlob(request.file, contentType), fileName);

    return mapUploadResult(
      await this.#sendJson({ method: "POST", path: "/api/v1/files", body: form }, options),
    );
  }

  /** Lists / searches file metadata with paging and filters. No file bytes are transferred. `GET /api/v1/files` */
  async listFiles(query?: FileListQuery, options?: RequestOptions): Promise<PagedResult<FileObject>> {
    const q = query ?? {};
    const toDateParam = (value: Date | string | undefined): Date | string | undefined =>
      typeof value === "string" && !isBlank(value) ? new Date(value) : value;
    const search = buildQuery([
      ["bucket", q.bucket],
      ["tenantId", q.tenantId],
      ["ownerId", q.ownerId],
      ["objectKeyPrefix", q.objectKeyPrefix],
      ["fileNameContains", q.fileNameContains],
      ["contentType", q.contentType],
      ["category", q.category],
      ["visibility", q.visibility],
      ["createdFromUTC", toDateParam(q.createdFromUtc)],
      ["createdToUTC", toDateParam(q.createdToUtc)],
      ["includeDeleted", q.includeDeleted],
      ["sortBy", q.sortBy],
      ["sortDescending", q.sortDescending],
      ["page", q.page],
      ["pageSize", q.pageSize],
    ]);
    return mapPagedFiles(await this.#sendJson({ method: "GET", path: `/api/v1/files${search}` }, options));
  }

  /** Reads one file's metadata without downloading it. `GET /api/v1/file-metadata/{bucket}/{objectKey}` */
  async getMetadata(bucket: string, objectKey: string, options?: RequestOptions): Promise<FileObject> {
    const path = `/api/v1/file-metadata/${encodePathSegment(bucket, "bucket")}/${encodeObjectKey(objectKey)}`;
    return mapFileObject(await this.#sendJson({ method: "GET", path }, options));
  }

  /** File count / size totals per category, optionally for one bucket. `GET /api/v1/files/summary` */
  async getSummary(bucket?: string, options?: RequestOptions): Promise<FileSummary> {
    const path = isBlank(bucket)
      ? "/api/v1/files/summary"
      : `/api/v1/files/summary?bucket=${escapeDataString(bucket)}`;
    return mapFileSummary(await this.#sendJson({ method: "GET", path }, options));
  }

  /**
   * Downloads a file through the authenticated route and hands back the response body as a stream; nothing
   * is buffered. Backend use only. `GET /api/v1/files/{bucket}/{objectKey}`
   */
  async download(bucket: string, objectKey: string, options?: RequestOptions): Promise<FileDownload> {
    const path = `/api/v1/files/${encodePathSegment(bucket, "bucket")}/${encodeObjectKey(objectKey)}`;
    return this.#send({ method: "GET", path, accept: "*/*", streaming: true }, options, (response) => {
      const headers = response.headers;
      const body: ReadableStream<Uint8Array> =
        response.body ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      const download: FileDownload = {
        body,
        contentType: parseMediaType(headers.get("content-type")),
        fileName: parseContentDispositionFileName(headers.get("content-disposition")),
        sizeBytes: parseLength(headers.get("content-length")),
        etag: headers.get("etag"),
        arrayBuffer: () => new Response(body).arrayBuffer(),
        text: () => new Response(body).text(),
      };
      return Promise.resolve(download);
    });
  }

  /**
   * Soft-deletes a file. Accepts `204 No Content` or a success envelope; a failure envelope throws.
   * `DELETE /api/v1/files/{bucket}/{objectKey}`
   */
  async delete(bucket: string, objectKey: string, options?: RequestOptions): Promise<void> {
    const path = `/api/v1/files/${encodePathSegment(bucket, "bucket")}/${encodeObjectKey(objectKey)}`;
    await this.#send({ method: "DELETE", path }, options, async (response, read) => {
      const text = await read(response.text());
      if (text.trim() === "") {
        return;
      }
      const envelope = parseEnvelope(text);
      if (envelope !== undefined && !envelope.success) {
        throw envelopeError(envelope, response);
      }
    });
  }

  /**
   * Creates one short-lived anonymous download URL for a private file, safe to give to a browser or mobile
   * app. Keep expiry short (5 to 15 minutes is typical). `POST /api/v1/files/presign`
   */
  async createPresignedUrl(request: PresignRequest, options?: RequestOptions): Promise<PresignedUrl> {
    if (typeof request !== "object" || request === null) {
      throw new TypeError("request is required.");
    }
    const json = {
      bucket: requireNonBlank(request.bucket, "bucket"),
      objectKey: requireNonBlank(request.objectKey, "objectKey"),
      expirySeconds: request.expirySeconds,
    };
    return mapPresignedUrl(
      await this.#sendJson({ method: "POST", path: "/api/v1/files/presign", json }, options),
    );
  }

  /**
   * Creates presigned URLs for many files in one call (max 200). Returns normally even when some targets
   * fail: always check `failed`. `POST /api/v1/files/presign/batch`
   */
  async createPresignedUrls(
    request: PresignBatchRequest,
    options?: RequestOptions,
  ): Promise<PresignBatchResult> {
    const targets: readonly PresignTarget[] | undefined = request?.targets;
    if (!Array.isArray(targets)) {
      throw new TypeError("request.targets must be an array.");
    }
    const json = {
      targets: targets.map((target: PresignTarget) => ({
        bucket: target.bucket,
        objectKey: target.objectKey,
      })),
      expirySeconds: request.expirySeconds,
    };
    return mapPresignBatchResult(
      await this.#sendJson({ method: "POST", path: "/api/v1/files/presign/batch", json }, options),
    );
  }

  /**
   * Builds the permanent anonymous URL of a file in a **Public** bucket:
   * `{publicBaseUrl ?? baseUrl}/public/{bucket}/{objectKey}`. Pure string work: no request is made, and it
   * does not check that the bucket is public or that the file exists.
   */
  buildPublicUrl(bucket: string, objectKey: string): string {
    const encodedBucket = encodePathSegment(bucket, "bucket");
    const encodedKey = encodeObjectKey(objectKey);
    const base = this.#publicBaseUrl ?? this.#baseUrl;
    if (base === undefined) {
      throw new CdnConfigurationError(
        "publicBaseUrl",
        `NinjaVault CDN publicBaseUrl (or baseUrl) is not configured. Pass { publicBaseUrl } or { baseUrl }, or set ${ENV_PUBLIC_BASE_URL} / ${ENV_BASE_URL}.`,
      );
    }
    const root = base.replace(/\/+$/, "");
    // Tolerate a publicBaseUrl copied from the server's own setting, which already ends in /public.
    const publicRoot = /\/public$/i.test(root) ? root : `${root}/public`;
    return `${publicRoot}/${encodedBucket}/${encodedKey}`;
  }

  // -------------------------------------------------------------------------------------------------------

  #requireConnection(): { baseUrl: string; apiKey: string; fetch: FetchLike } {
    if (this.#baseUrl === undefined) {
      throw new CdnConfigurationError(
        "baseUrl",
        `NinjaVault CDN baseUrl is not configured. Pass { baseUrl } to NinjaVaultCdnClient or set ${ENV_BASE_URL}.`,
      );
    }
    if (this.#apiKey === undefined) {
      throw new CdnConfigurationError(
        "apiKey",
        `NinjaVault CDN apiKey is not configured. Pass { apiKey } to NinjaVaultCdnClient or set ${ENV_API_KEY}.`,
      );
    }
    if (this.#fetch === undefined) {
      throw new CdnConfigurationError(
        "fetch",
        "No global fetch is available in this runtime. Pass { fetch } to NinjaVaultCdnClient.",
      );
    }
    return { baseUrl: this.#baseUrl, apiKey: this.#apiKey, fetch: this.#fetch };
  }

  async #sendJson(init: SendInit, options: RequestOptions | undefined): Promise<unknown> {
    return this.#send(init, options, async (response, read) => {
      const text = await read(response.text());
      if (text.trim() === "") {
        throw new CdnApiError("CDN response body was empty.", { statusCode: response.status });
      }
      const envelope = parseEnvelope(text);
      if (envelope === undefined) {
        throw new CdnApiError("CDN response was not a valid JSON envelope.", {
          statusCode: response.status,
          description: text.slice(0, MAX_RAW_ERROR_BODY),
        });
      }
      if (!envelope.success) {
        throw envelopeError(envelope, response);
      }
      if (envelope.data === undefined || envelope.data === null) {
        throw new CdnApiError("CDN response envelope contained no data.", { statusCode: response.status });
      }
      return envelope.data;
    });
  }

  async #send<T>(
    init: SendInit,
    options: RequestOptions | undefined,
    consume: (response: Response, read: <R>(promise: Promise<R>) => Promise<R>) => Promise<T>,
  ): Promise<T> {
    const connection = this.#requireConnection();
    const url = joinUrl(connection.baseUrl, init.path);
    const method = init.method;
    const userSignal = options?.signal;
    userSignal?.throwIfAborted();

    const headers: Record<string, string> = {
      [API_KEY_HEADER]: connection.apiKey,
      "User-Agent": this.#userAgent,
      Accept: init.accept ?? "application/json",
    };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }

    await safeHook(this.#hooks.onRequest, {
      method,
      url,
      headers: redact(headers),
      setHeader(name: string, value: string) {
        if (name.toLowerCase() !== API_KEY_HEADER.toLowerCase()) {
          headers[name] = value;
        }
      },
    });
    const loggedHeaders = redact(headers);
    // The hook is awaited, so the caller may have aborted in the meantime.
    userSignal?.throwIfAborted();

    // One controller carries both the SDK timeout and the caller's signal to fetch.
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUserAbort = (): void => controller.abort(userSignal?.reason);
    userSignal?.addEventListener("abort", onUserAbort, { once: true });
    if (this.#timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new CdnTimeoutError(this.#timeoutMs, method, url));
      }, this.#timeoutMs);
    }
    // Rejects as soon as the controller aborts, even if a custom fetch/body ignores the signal.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), {
        once: true,
      });
    });
    aborted.catch(() => undefined);
    const read = <R>(promise: Promise<R>): Promise<R> => Promise.race([promise, aborted]);

    let keepLinked = false;
    let status: number | undefined;
    const started = now();
    try {
      const requestInit: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) {
        requestInit.body = body;
      }
      const response = await read(connection.fetch(url, requestInit));
      status = response.status;
      await safeHook(this.#hooks.onResponse, {
        method,
        url,
        headers: loggedHeaders,
        status,
        durationMs: now() - started,
      });

      if (!response.ok) {
        throw await this.#errorFromResponse(response, read);
      }

      if (init.streaming === true) {
        // Headers are in: stop the timeout so long downloads are not cut off, but keep honouring the
        // caller's signal while the body streams.
        clearTimeout(timer);
        keepLinked = true;
      }
      return await consume(response, read);
    } catch (caught) {
      keepLinked = false;
      let error: unknown = caught;
      if (timedOut) {
        error = controller.signal.reason;
      } else if (userSignal?.aborted === true) {
        error = userSignal.reason;
      }
      await safeHook(this.#hooks.onError, {
        method,
        url,
        headers: loggedHeaders,
        status,
        durationMs: now() - started,
        error,
      });
      throw error;
    } finally {
      clearTimeout(timer);
      if (!keepLinked) {
        userSignal?.removeEventListener("abort", onUserAbort);
      }
    }
  }

  async #errorFromResponse(
    response: Response,
    read: <R>(promise: Promise<R>) => Promise<R>,
  ): Promise<CdnApiError> {
    let text = "";
    try {
      text = await read(response.text());
    } catch {
      // Unreadable error body: report the status alone. (A timeout or caller abort that happens here is
      // still surfaced, because #send maps any error thrown after an abort to the abort reason.)
    }
    const envelope = text.trim() === "" ? undefined : parseEnvelope(text);
    const error = envelope?.error;
    const rawBody = text.trim() === "" ? undefined : text.slice(0, MAX_RAW_ERROR_BODY);
    return new CdnApiError(error?.message ?? `CDN request failed with HTTP ${response.status}.`, {
      statusCode: response.status,
      errorCode: error?.errorCode,
      // Anonymous/download routes may answer with a raw (non-envelope) body; surface it as the description.
      description: error === undefined ? rawBody : error.description,
      correlationId: error?.traceId,
      details: error?.details,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
}
