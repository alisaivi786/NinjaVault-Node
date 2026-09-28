<p align="center">
  <img src="https://raw.githubusercontent.com/alisaivi786/NinjaVault/main/assets/icon-512.png" width="112" alt="NinjaVault" />
</p>

<h1 align="center">@ninjavault/cdn</h1>

<p align="center">
  Typed, zero-dependency Node.js / TypeScript client for the <b>NinjaVault CDN Server</b>: upload, search, download and share files with one class.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ninjavault/cdn"><img src="https://img.shields.io/npm/v/@ninjavault/cdn.svg?label=%40ninjavault%2Fcdn" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@ninjavault/cdn"><img src="https://img.shields.io/npm/dm/@ninjavault/cdn.svg" alt="npm downloads" /></a>
  <a href="https://www.npmjs.com/package/@ninjavault/cdn"><img src="https://img.shields.io/node/v/@ninjavault/cdn.svg" alt="Node version" /></a>
  <a href="https://github.com/alisaivi786/NinjaVault-Node/actions/workflows/ci.yml"><img src="https://github.com/alisaivi786/NinjaVault-Node/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/alisaivi786/NinjaVault-Node/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/types-included-3178C6?logo=typescript&logoColor=white" alt="Types included" />
</p>

---

## Why @ninjavault/cdn

- **One class, every operation.** Upload, list/search, metadata, usage summary, download, soft delete, public URLs, and single or batch presigned URLs.
- **No HTTP plumbing.** Handles the `X-Api-Key` header, multipart fields, object-key encoding, and the JSON success/error envelope for you.
- **Typed errors.** Every failure is a `CdnApiError` with the HTTP status, CDN error code, trace id, validation details, and `retryAfterMs`.
- **Zero runtime dependencies.** Built on the platform's `fetch`, `FormData`, `Blob` and web streams: Node 18+, Bun, Deno and edge runtimes.
- **No opinions.** Logging, correlation ids and retries stay under your control through small hooks and your own `fetch`.
- **Streams large files.** Downloads are handed to you as a `ReadableStream` and never buffered in memory.
- **ESM and CommonJS**, with TypeScript types for both.

---

## Quick start

**1. Install**

```bash
npm install @ninjavault/cdn
# or
pnpm add @ninjavault/cdn
# or
yarn add @ninjavault/cdn
```

**2. Configure** (environment variables, read automatically)

```bash
export NINJAVAULT_CDN_BASE_URL="https://cdn.example.com"
export NINJAVAULT_CDN_API_KEY="cdn_xxxxx"      # backend-only secret: never commit it
```

**3. Use**

```ts
import { NinjaVaultCdnClient } from "@ninjavault/cdn";

const cdn = new NinjaVaultCdnClient(); // reads NINJAVAULT_CDN_* from the environment

const file = await cdn.upload({
  bucket: "documents",
  tenantId: 42,
  file: pdfBytes, // Blob | ArrayBuffer | Uint8Array
  fileName: "invoice.pdf",
  contentType: "application/pdf",
});

console.log(file.objectKey); // store bucket + objectKey in your database
```

CommonJS works too: `const { NinjaVaultCdnClient } = require("@ninjavault/cdn");`

That's it. Everything below is optional.

> This SDK is for **server-side** code. The API key must never reach a browser or mobile app; see
> [Give a browser or mobile app access](#give-a-browser-or-mobile-app-access).

---

## Configuration reference

```ts
const cdn = new NinjaVaultCdnClient({
  baseUrl: "https://cdn.example.com",
  apiKey: process.env.MY_SECRET_STORE_CDN_KEY,
  publicBaseUrl: "https://cdn.example.com",
  timeoutMs: 30_000,
});
```

| Option          | Environment variable             | Required | Default                         | Description                                                                                                                            |
| --------------- | -------------------------------- | :------: | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`       | `NINJAVAULT_CDN_BASE_URL`        |    ✅    | none                            | Base URL of the authenticated `/api/v1/...` routes. A path prefix works (`https://gateway.example.com/cdn`).                           |
| `apiKey`        | `NINJAVAULT_CDN_API_KEY`         |    ✅    | none                            | The `X-Api-Key` issued for your integration. **Backend-only secret.**                                                                  |
| `publicBaseUrl` | `NINJAVAULT_CDN_PUBLIC_BASE_URL` |          | `baseUrl`                       | Host for anonymous public files. **Host only**; the client appends `/public/`.                                                         |
| `timeoutMs`     |                                  |          | `30000`                         | Per-request timeout until the response arrives. Downloads are not cut off once streaming starts. `0` disables it.                      |
| `fetch`         |                                  |          | `globalThis.fetch`              | Custom `fetch` (tests, proxies, instrumentation, retries).                                                                             |
| `hooks`         |                                  |          | none                            | `onRequest` / `onResponse` / `onError` callbacks for logging and correlation. See [Logging and correlation](#logging-and-correlation). |
| `userAgent`     |                                  |          | `ninjavault-cdn-node/<version>` | Overrides the `User-Agent` header.                                                                                                     |

Explicit options win over environment variables. A missing `baseUrl` or `apiKey` throws a
`CdnConfigurationError` naming the setting (`error.setting === "apiKey"`) on the first call, so a client used
only for `buildPublicUrl` does not need an API key. Environment variables are read only where `process.env`
exists; in browsers, edge runtimes and Deno without `--allow-env`, pass options explicitly.

### Verify the key at startup (recommended)

```ts
const access = await cdn.getAccessContext();
// access.allowedBuckets / access.allowedTenantIds empty = unrestricted, not "no access"
console.log(access.name, access.isUnrestricted, access.allowedTenantIds);
```

---

## Usage

Every async method takes an optional last argument `{ signal }` (an `AbortSignal`) to cancel the call.

### Upload

```ts
const uploaded = await cdn.upload({
  bucket: "documents",
  tenantId: 42, // positive integer or GUID string
  file: bytes, // Blob | ArrayBuffer | Uint8Array
  fileName: "report.docx",
  contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ownerId: 1001, // optional
  folderPath: "reports/2026", // optional: up to 8 segments of [A-Za-z0-9_-]
});

// uploaded.bucket + uploaded.objectKey identify the file from now on (not the original file name).
```

Always pass `contentType`: allowed content types and the maximum size are set per CDN deployment (commonly
PDF, JPEG, PNG, WEBP, DOC and DOCX, up to about 25 MB). Anything outside them fails with `40001`.

#### Uploading a file from disk (Node)

```ts
import { openAsBlob } from "node:fs"; // Node >= 19.8: streams from disk, no full read into memory
import { readFile } from "node:fs/promises"; // any Node version: reads the file into memory

const file = await openAsBlob("./invoice.pdf", { type: "application/pdf" });
// const file = await readFile("./invoice.pdf");

await cdn.upload({
  bucket: "documents",
  tenantId: 42,
  file,
  fileName: "invoice.pdf",
  contentType: "application/pdf",
});
```

From an Express/Multer upload: `file: req.file.buffer, fileName: req.file.originalname, contentType: req.file.mimetype`.

### Give a browser or mobile app access

| The file is in...    | Use                                     | Makes an HTTP call? | Link lifetime      |
| -------------------- | --------------------------------------- | :-----------------: | ------------------ |
| a **Public** bucket  | `cdn.buildPublicUrl(bucket, objectKey)` |         no          | permanent          |
| a **Private** bucket | `cdn.createPresignedUrl({ ... })`       |         yes         | short (you choose) |
| many private files   | `cdn.createPresignedUrls({ ... })`      |      yes, once      | short              |

```ts
const logoUrl = cdn.buildPublicUrl("public-assets", objectKey);

const link = await cdn.createPresignedUrl({ bucket: "documents", objectKey, expirySeconds: 600 });
// link.url, link.expiresAtUtc (Date)

const batch = await cdn.createPresignedUrls({
  targets: [
    { bucket: "documents", objectKey: keyA },
    { bucket: "documents", objectKey: keyB },
  ],
  expirySeconds: 600,
});

for (const failed of batch.failed) {
  // The batch succeeds even if some targets fail: always check `failed`.
  console.warn(`${failed.objectKey}: ${failed.reason}`); // "NotFound" | "Forbidden"
}
```

`expirySeconds` defaults to the server's setting (300 s by default) and is clamped to its maximum (3600 s by
default). A batch takes at most 200 targets.

> [!WARNING]
> **Never send the API key to a browser or mobile app**, and never call this SDK from browser code. Anyone who
> can read the key can upload, list, download and delete every file it can reach. Give clients a public or
> presigned URL instead.

### Download (backend to backend)

`download()` returns as soon as the headers arrive. The body is a web `ReadableStream`, so a large file is
never held in memory.

```ts
const download = await cdn.download("documents", objectKey);
download.contentType; // "application/pdf" | null
download.fileName; // original file name from Content-Disposition | null
download.sizeBytes; // Content-Length | null
download.body; // ReadableStream<Uint8Array>
// or, for small files: await download.arrayBuffer() / await download.text()
```

**Express**

```ts
import { Readable } from "node:stream";

app.get("/files/:key", async (req, res, next) => {
  try {
    const file = await cdn.download("documents", req.params.key);
    res.setHeader("Content-Type", file.contentType ?? "application/octet-stream");
    if (file.sizeBytes !== null) res.setHeader("Content-Length", file.sizeBytes);
    if (file.fileName) res.attachment(file.fileName);
    // TypeScript: if DOM and Node stream types clash, cast: file.body as import("node:stream/web").ReadableStream
    Readable.fromWeb(file.body).pipe(res);
  } catch (error) {
    next(error);
  }
});
```

**Next.js route handler** (`app/files/[key]/route.ts`)

```ts
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const file = await cdn.download("documents", key);
  return new Response(file.body, {
    headers: {
      "Content-Type": file.contentType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName ?? key)}`,
    },
  });
}
```

**Save to disk**

```ts
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const file = await cdn.download("documents", objectKey);
await pipeline(Readable.fromWeb(file.body), createWriteStream("./copy.pdf"));
```

Read the body exactly once (stream it, or call `arrayBuffer()`/`text()`).

### Search and list

```ts
import { FileCategory, FileSortBy } from "@ninjavault/cdn";

const page = await cdn.listFiles({
  bucket: "documents",
  tenantId: 42,
  ownerId: 1001,
  objectKeyPrefix: "reports/2026",
  fileNameContains: "invoice",
  category: FileCategory.Document,
  createdFromUtc: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  sortBy: FileSortBy.CreatedAtUtc,
  sortDescending: true,
  page: 1,
  pageSize: 50, // 1 to 200
});

page.items; // FileObject[] (createdAtUtc is a Date)
page.totalCount;
```

### Metadata, usage, buckets, delete

```ts
const info = await cdn.getMetadata("documents", objectKey); // checksum, category, thumbnail, createdAtUtc...
const usage = await cdn.getSummary("documents"); // totals per category (omit the bucket for all)
const buckets = await cdn.listBuckets(); // visibility + counters
await cdn.delete("documents", objectKey); // soft delete
```

### Cancel a call

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);
await cdn.listFiles({ bucket: "documents" }, { signal: controller.signal }); // rejects with an AbortError
```

---

## Error handling

```ts
import { CdnApiError, CdnTimeoutError, ErrorCode } from "@ninjavault/cdn";

try {
  await cdn.upload(request);
} catch (error) {
  if (error instanceof CdnTimeoutError) {
    // no response within timeoutMs (error.statusCode === 0)
  } else if (error instanceof CdnApiError) {
    console.warn(
      `CDN ${error.statusCode} ${error.errorCode}: ${error.message} (trace ${error.correlationId})`,
      error.details, // e.g. { FolderPath: ["..."] }
    );
    if (error.errorCode === ErrorCode.TooManyRequests && error.retryAfterMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
    }
  } else {
    throw error; // AbortError from your signal, network failure, or invalid arguments (TypeError)
  }
}
```

| `errorCode` | HTTP | `ErrorCode.`          | Meaning           | What to check                                                  |
| ----------- | :--: | --------------------- | ----------------- | -------------------------------------------------------------- |
| `40001`     | 400  | `ValidationFailed`    | Validation failed | `folderPath` format, content type, file size, `error.details`  |
| `40101`     | 401  | `Unauthorized`        | Unauthorized      | `apiKey` missing, mistyped, or revoked                         |
| `40301`     | 403  | `Forbidden`           | Forbidden         | Key not allowed for this bucket or tenant (`getAccessContext`) |
| `40401`     | 404  | `NotFound`            | Not found         | Bucket name or object key (use `objectKey`, not the file name) |
| `40901`     | 409  | `Conflict`            | Conflict          | Quota exceeded or conflicting state                            |
| `42901`     | 429  | `TooManyRequests`     | Too many requests | Wait for `error.retryAfterMs`                                  |
| `50001`     | 500  | `InternalServerError` | Server error      | Retry later; send `error.correlationId` to the CDN team        |

`CdnApiError` fields: `statusCode`, `errorCode`, `message`, `description`, `correlationId` (the server's
`traceId`), `details`, `retryAfterMs`. When the server answers with a non-JSON body (for example a proxy error
page), `errorCode` is `undefined` and the raw body (truncated) is in `description`.

---

## Logging, correlation and retries

`@ninjavault/cdn` logs nothing by itself. Attach whatever your app uses through `hooks`. Header values passed
to hooks have the API key replaced by `[REDACTED]`, so they are safe to log.

```ts
import { randomUUID } from "node:crypto";

const cdn = new NinjaVaultCdnClient({
  hooks: {
    onRequest(ctx) {
      ctx.setHeader("X-Correlation-Id", getCorrelationId() ?? randomUUID()); // propagate your correlation id
      logger.debug({ method: ctx.method, url: ctx.url, headers: ctx.headers }, "CDN request");
    },
    onResponse(ctx) {
      logger.info(
        { method: ctx.method, url: ctx.url, status: ctx.status, ms: ctx.durationMs },
        "CDN response",
      );
    },
    onError(ctx) {
      logger.warn(
        { method: ctx.method, url: ctx.url, status: ctx.status, ms: ctx.durationMs, err: ctx.error },
        "CDN call failed",
      );
    },
  },
});
```

Hooks may be async (they are awaited). An exception thrown by a hook is swallowed, so logging can never break a
CDN call. `setHeader` cannot change `X-Api-Key`.

---

### Retries

The SDK never retries on its own, because uploads and deletes are not always safe to repeat. Retry where it
makes sense for you, and respect `retryAfterMs`:

```ts
async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const retryable =
        error instanceof CdnApiError &&
        (error.statusCode === 429 || error.statusCode >= 500 || error instanceof CdnTimeoutError);
      if (!retryable || attempt >= attempts) throw error;
      const delay = error.retryAfterMs ?? 250 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const buckets = await withRetry(() => cdn.listBuckets());
```

---

## Unit testing your code

Inject a fake `fetch`; no network, no mocking library needed:

```ts
const fetch = async (url: string, init: RequestInit) =>
  new Response(
    JSON.stringify({
      success: true,
      data: [{ name: "documents", visibility: "Private", fileCount: 0, totalSizeBytes: 0 }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );

const cdn = new NinjaVaultCdnClient({ baseUrl: "https://cdn.test", apiKey: "cdn_test_xxxxx", fetch });
expect(await cdn.listBuckets()).toHaveLength(1);
```

Or depend on the class's shape in your own code and substitute a stub:
`type Cdn = Pick<NinjaVaultCdnClient, "upload" | "buildPublicUrl">`.

---

## Troubleshooting

| Symptom                                         | Fix                                                                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public URLs contain `/public/public/`           | Set `publicBaseUrl` to the host only (`https://cdn.example.com`), or remove it. (This SDK also strips a trailing `/public` for you.)                                                                  |
| `CdnConfigurationError: ... baseUrl` / `apiKey` | Pass the option or set `NINJAVAULT_CDN_BASE_URL` / `NINJAVAULT_CDN_API_KEY` in the environment the process actually runs in.                                                                          |
| `40101` on every call                           | Wrong or rotated key. Check `NINJAVAULT_CDN_API_KEY`.                                                                                                                                                 |
| `40001` on upload                               | Invalid `folderPath` (max 8 segments of `[A-Za-z0-9_-]`, each starting with a letter or digit), a missing/disallowed `contentType`, or a file larger than the deployment allows. See `error.details`. |
| `40401` right after upload                      | Fetch with the returned `objectKey`, not the original file name.                                                                                                                                      |
| `CdnTimeoutError` on large uploads              | Raise `timeoutMs` (the timeout covers the whole upload request).                                                                                                                                      |
| `ReferenceError: fetch is not defined`          | Node < 18. Upgrade, or pass a `fetch` implementation.                                                                                                                                                 |
| `TypeError: Body is unusable`                   | The download body was read twice. Read it once.                                                                                                                                                       |

---

## Compatibility

|              |                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Runtimes     | Node.js 18+, Bun, Deno, and edge runtimes with `fetch` (server-side only)                                        |
| Modules      | ESM (`import`) and CommonJS (`require`)                                                                          |
| TypeScript   | Types included (`.d.ts` and `.d.cts`), `strict` and `exactOptionalPropertyTypes` friendly                        |
| Dependencies | none                                                                                                             |
| Version      | Same number in every NinjaVault SDK: `@ninjavault/cdn`, `ninjavault-cdn` and `NinjaVault.Cdn` are all `100.42.1` |

## NinjaVault SDKs

The same CDN client in every language, with the same features and the **same version number** (for example `100.42.1` everywhere):

| Language     | Package                                                            | Install                             | Source                                                                |
| ------------ | ------------------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------- |
| .NET 8+      | [`NinjaVault.Cdn`](https://www.nuget.org/packages/NinjaVault.Cdn)  | `dotnet add package NinjaVault.Cdn` | [NinjaVault](https://github.com/alisaivi786/NinjaVault)               |
| Python 3.10+ | [`ninjavault-cdn`](https://pypi.org/project/ninjavault-cdn/)       | `pip install ninjavault-cdn`        | [NinjaVault-Python](https://github.com/alisaivi786/NinjaVault-Python) |
| Node.js 18+  | [`@ninjavault/cdn`](https://www.npmjs.com/package/@ninjavault/cdn) | `npm install @ninjavault/cdn`       | [NinjaVault-Node](https://github.com/alisaivi786/NinjaVault-Node)     |

---

## Links

- Source and issues: <https://github.com/alisaivi786/NinjaVault-Node>
- Release notes (change-sets): <https://github.com/alisaivi786/NinjaVault-Node/tree/main/changesets>
- Security policy: [SECURITY.md](https://github.com/alisaivi786/NinjaVault-Node/blob/main/SECURITY.md)
- License: MIT
