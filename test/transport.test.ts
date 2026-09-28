/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CdnApiError,
  CdnConfigurationError,
  CdnTimeoutError,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_PUBLIC_BASE_URL,
  ErrorCode,
  NinjaVaultCdnClient,
  SDK_VERSION,
  type CdnErrorContext,
  type CdnRequestContext,
  type CdnResponseContext,
} from "../src/index.js";
import { API_KEY, createClient, fail, mockFetch, ok } from "./helpers.js";

const UPLOAD_RESULT = {
  id: "1cf8e5e6-21f0-49a5-90b1-5c0f985c9df7",
  bucket: "documents",
  objectKey: "owner-token/invoices/2026/file.pdf",
  originalFileName: "invoice.pdf",
  contentType: "application/pdf",
  sizeBytes: 7,
  visibility: "Private",
  url: "https://cdn.test/api/v1/files/documents/owner-token/invoices/2026/file.pdf",
};

async function multipartText(body: unknown): Promise<string> {
  return new Response(body as FormData).text();
}

describe("upload", () => {
  it("sends the multipart fields Bucket, TenantId, OwnerId, FolderPath and File", async () => {
    const fetch = mockFetch(() => ok({ ...UPLOAD_RESULT, viewUrl: null }));
    const result = await createClient(fetch).upload({
      bucket: "documents",
      tenantId: 42,
      file: new TextEncoder().encode("payload"),
      fileName: "invoice.pdf",
      contentType: "application/pdf",
      ownerId: 1001,
      folderPath: "invoices/2026",
    });

    const request = fetch.single();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://cdn.test/api/v1/files");
    expect(request.headers["x-api-key"]).toBe(API_KEY);
    // fetch must set multipart/form-data with its own boundary.
    expect(request.headers["content-type"]).toBeUndefined();

    const form = request.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toEqual(["Bucket", "TenantId", "OwnerId", "FolderPath", "File"]);
    expect(form.get("Bucket")).toBe("documents");
    expect(form.get("TenantId")).toBe("42");
    expect(form.get("OwnerId")).toBe("1001");
    expect(form.get("FolderPath")).toBe("invoices/2026");
    const file = form.get("File") as File;
    expect(file.name).toBe("invoice.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("payload");

    const wire = await multipartText(form);
    expect(wire).toContain('name="File"; filename="invoice.pdf"');
    expect(wire).toContain("Content-Type: application/pdf");

    expect(result).toEqual({ ...UPLOAD_RESULT, viewUrl: null });
  });

  it("omits OwnerId and FolderPath when not given, and accepts GUID tenant ids and bigint", async () => {
    const fetch = mockFetch(() => ok(UPLOAD_RESULT));
    const client = createClient(fetch);
    const result = await client.upload({
      bucket: "documents",
      tenantId: " 7d7c1b4e-7a8e-4c56-9f1b-8f7f2d3f4a11 ",
      file: new ArrayBuffer(3),
      fileName: "a.bin",
      folderPath: "  ",
    });
    const form = fetch.requests[0]!.body as FormData;
    expect([...form.keys()]).toEqual(["Bucket", "TenantId", "File"]);
    expect(form.get("TenantId")).toBe("7d7c1b4e-7a8e-4c56-9f1b-8f7f2d3f4a11");
    expect(result.viewUrl).toBeNull();

    await client.upload({
      bucket: "b",
      tenantId: 9007199254740993n,
      ownerId: "77",
      file: new Uint8Array(1),
      fileName: "x",
    });
    const form2 = fetch.requests[1]!.body as FormData;
    expect(form2.get("TenantId")).toBe("9007199254740993");
    expect(form2.get("OwnerId")).toBe("77");
  });

  it("uses a Blob as-is, or re-types it without copying when contentType differs", async () => {
    const fetch = mockFetch(() => ok(UPLOAD_RESULT));
    const client = createClient(fetch);
    const blob = new Blob(["hello"], { type: "text/plain" });

    await client.upload({ bucket: "b", tenantId: 1, file: blob, fileName: "a.txt" });
    await client.upload({
      bucket: "b",
      tenantId: 1,
      file: blob,
      fileName: "a.txt",
      contentType: "text/plain",
    });
    await client.upload({ bucket: "b", tenantId: 1, file: blob, fileName: "a.csv", contentType: "text/csv" });

    const files = fetch.requests.map((r) => (r.body as FormData).get("File") as File);
    expect(files.map((f) => f.type)).toEqual(["text/plain", "text/plain", "text/csv"]);
    expect(await files[2]!.text()).toBe("hello");
  });

  it("accepts a DataView / typed array view over part of a buffer", async () => {
    const fetch = mockFetch(() => ok(UPLOAD_RESULT));
    const bytes = new TextEncoder().encode("xxHELLOxx");
    await createClient(fetch).upload({
      bucket: "b",
      tenantId: 1,
      file: new DataView(bytes.buffer, 2, 5),
      fileName: "a.txt",
    });
    const file = (fetch.single().body as FormData).get("File") as File;
    expect(await file.text()).toBe("HELLO");
  });

  it("validates the request", async () => {
    const client = createClient(mockFetch(() => ok(UPLOAD_RESULT)));
    const file = new Uint8Array(1);
    await expect(client.upload({ bucket: "", tenantId: 1, file, fileName: "a" })).rejects.toThrow("bucket");
    await expect(client.upload({ bucket: "b", tenantId: 1, file, fileName: " " })).rejects.toThrow(
      "fileName",
    );
    await expect(client.upload({ bucket: "b", tenantId: "", file, fileName: "a" })).rejects.toThrow(
      "tenantId",
    );
    await expect(client.upload({ bucket: "b", tenantId: Number.NaN, file, fileName: "a" })).rejects.toThrow(
      "finite",
    );
    // @ts-expect-error: runtime guards for JS callers
    await expect(client.upload({ bucket: "b", file, fileName: "a" })).rejects.toThrow(
      "tenantId is required.",
    );
    // @ts-expect-error: runtime guards for JS callers
    await expect(client.upload({ bucket: "b", tenantId: 1, fileName: "a" })).rejects.toThrow(
      "file is required.",
    );
    // @ts-expect-error: runtime guards for JS callers
    await expect(client.upload({ bucket: "b", tenantId: 1, file: "text", fileName: "a" })).rejects.toThrow(
      "file must be a Blob",
    );
    // @ts-expect-error: runtime guards for JS callers
    await expect(client.upload({ bucket: "b", tenantId: {}, file, fileName: "a" })).rejects.toThrow(
      "tenantId must be a string, number or bigint.",
    );
    // @ts-expect-error: runtime guards for JS callers
    await expect(client.upload(undefined)).rejects.toThrow("request is required.");
  });
});

describe("download", () => {
  it("streams the body and exposes content type, file name, size and etag", async () => {
    const fetch = mockFetch(
      () =>
        new Response("file-bytes", {
          headers: {
            "Content-Type": "application/pdf; charset=binary",
            "Content-Disposition": "attachment; filename=a.pdf; filename*=UTF-8''r%C3%A9sum%C3%A9%20v2.pdf",
            "Content-Length": "10",
            ETag: '"abc123"',
          },
        }),
    );
    const download = await createClient(fetch).download("my docs", "folder/a.pdf");

    const request = fetch.single();
    expect(request.url).toBe("https://cdn.test/api/v1/files/my%20docs/folder/a.pdf");
    expect(request.headers.accept).toBe("*/*");
    expect(download.body).toBeInstanceOf(ReadableStream);
    expect(download.contentType).toBe("application/pdf");
    expect(download.fileName).toBe("résumé v2.pdf");
    expect(download.sizeBytes).toBe(10);
    expect(download.etag).toBe('"abc123"');

    const chunks: Uint8Array[] = [];
    for await (const chunk of download.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("file-bytes");
  });

  it("does not read the body before the caller does (no buffering)", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fetch = mockFetch(() => new Response(stream));
    const download = await createClient(fetch).download("b", "k");
    expect(pulled).toBe(0);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(pulled).toBe(1);
  });

  it("reads quoted filename, text(), and missing headers as null", async () => {
    const fetch = mockFetch(
      () =>
        new Response("hello", {
          headers: { "Content-Disposition": 'attachment; filename="my \\"quoted\\" file.txt"' },
        }),
    );
    const download = await createClient(fetch).download("b", "k");
    expect(download.fileName).toBe('my "quoted" file.txt');
    expect(await download.text()).toBe("hello");

    const bare = await createClient(mockFetch(() => new Response(null, { status: 200 }))).download("b", "k");
    expect(bare.contentType).toBeNull();
    expect(bare.fileName).toBeNull();
    expect(bare.sizeBytes).toBeNull();
    expect(bare.etag).toBeNull();
    expect(await bare.text()).toBe("");
  });

  it.each([
    ["attachment", null],
    ["attachment; filename=plain.pdf", "plain.pdf"],
    ["attachment; filename*=utf-8''a%20b.pdf", "a b.pdf"],
    ["attachment; filename*=''a%20b.pdf", "a b.pdf"],
    ["attachment; filename*=iso-8859-1'en'%E9t%E9.txt; filename=ete.txt", "été.txt"],
    ["attachment; filename*=UTF-8''%E0%A4%A; filename=fallback.pdf", "fallback.pdf"],
    ["attachment; filename*=garbage; filename=fallback.pdf", "fallback.pdf"],
    ['attachment; filename=""', null],
    ["attachment; FILENAME=Upper.pdf; filename=second.pdf", "Upper.pdf"],
  ])("parses Content-Disposition %j", async (header, expected) => {
    const fetch = mockFetch(() => new Response("x", { headers: { "Content-Disposition": header } }));
    expect((await createClient(fetch).download("b", "k")).fileName).toBe(expected);
  });

  it("maps a non-JSON error body to CdnApiError with the raw body as description", async () => {
    const fetch = mockFetch(
      () => new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );
    const error = (await createClient(fetch)
      .download("b", "k")
      .catch((e: unknown) => e)) as CdnApiError;
    expect(error).toBeInstanceOf(CdnApiError);
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("CDN request failed with HTTP 404.");
    expect(error.description).toBe("Not Found");
    expect(error.errorCode).toBeUndefined();
  });
});

describe("error mapping", () => {
  it("maps the envelope: status, errorCode, message, description, traceId -> correlationId, details", async () => {
    const fetch = mockFetch(() =>
      fail(403, {
        errorCode: 40301,
        message: "Forbidden",
        description: "Bucket is not allowed.",
        traceId: "corr-1",
        details: { Bucket: ["Denied"], Other: "single" },
      }),
    );
    const error = (await createClient(fetch)
      .listBuckets()
      .catch((e: unknown) => e)) as CdnApiError;

    expect(error).toBeInstanceOf(CdnApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CdnApiError");
    expect(error.statusCode).toBe(403);
    expect(error.errorCode).toBe(ErrorCode.Forbidden);
    expect(error.message).toBe("Forbidden");
    expect(error.description).toBe("Bucket is not allowed.");
    expect(error.correlationId).toBe("corr-1");
    expect(error.details).toEqual({ Bucket: ["Denied"], Other: ["single"] });
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("accepts correlationId as a fallback name and null details", async () => {
    const fetch = mockFetch(() =>
      fail(500, { errorCode: "50001", message: "Boom", correlationId: "c-9", details: null }),
    );
    await expect(createClient(fetch).listBuckets()).rejects.toMatchObject({
      errorCode: 50001,
      correlationId: "c-9",
      details: undefined,
      description: undefined,
    });
  });

  it("handles an error response with an empty body", async () => {
    const fetch = mockFetch(() => new Response(null, { status: 502 }));
    await expect(createClient(fetch).listBuckets()).rejects.toMatchObject({
      statusCode: 502,
      message: "CDN request failed with HTTP 502.",
      description: undefined,
    });
  });

  it("handles an error whose body cannot be read", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    const fetch = mockFetch(() => new Response(body, { status: 503 }));
    await expect(createClient(fetch).listBuckets()).rejects.toMatchObject({ statusCode: 503 });
  });

  it("truncates very large raw error bodies", async () => {
    const fetch = mockFetch(() => new Response("x".repeat(10_000), { status: 500 }));
    const error = (await createClient(fetch)
      .listBuckets()
      .catch((e: unknown) => e)) as CdnApiError;
    expect(error.description).toHaveLength(2_000);
  });

  it("reads Retry-After as delta seconds on 429", async () => {
    const fetch = mockFetch(() =>
      fail(
        429,
        { errorCode: 42901, message: "Too many requests", traceId: "corr-2" },
        { "Retry-After": "30" },
      ),
    );
    await expect(createClient(fetch).listBuckets()).rejects.toMatchObject({
      statusCode: 429,
      errorCode: ErrorCode.TooManyRequests,
      retryAfterMs: 30_000,
    });
  });

  it("reads Retry-After as an HTTP-date (and clamps past dates to 0)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
    try {
      const future = mockFetch(() =>
        fail(429, { errorCode: 42901, message: "x" }, { "Retry-After": "Mon, 28 Sep 2026 12:00:45 GMT" }),
      );
      await expect(createClient(future).listBuckets()).rejects.toMatchObject({ retryAfterMs: 45_000 });

      const past = mockFetch(() =>
        fail(429, { errorCode: 42901, message: "x" }, { "Retry-After": "Mon, 28 Sep 2026 11:00:00 GMT" }),
      );
      await expect(createClient(past).listBuckets()).rejects.toMatchObject({ retryAfterMs: 0 });

      const garbage = mockFetch(() =>
        fail(429, { errorCode: 42901, message: "x" }, { "Retry-After": "soon" }),
      );
      await expect(createClient(garbage).listBuckets()).rejects.toMatchObject({ retryAfterMs: undefined });

      const blank = mockFetch(() => fail(429, { errorCode: 42901, message: "x" }, { "Retry-After": " " }));
      await expect(createClient(blank).listBuckets()).rejects.toMatchObject({ retryAfterMs: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts Retry-After on a failure envelope returned with HTTP 200", async () => {
    const fetch = mockFetch(() => fail(200, { errorCode: 42901, message: "x" }, { "Retry-After": "5" }));
    await expect(createClient(fetch).getSummary()).rejects.toMatchObject({ retryAfterMs: 5_000 });
  });

  it("exports every server error code", () => {
    expect(ErrorCode).toEqual({
      ValidationFailed: 40001,
      Unauthorized: 40101,
      Forbidden: 40301,
      NotFound: 40401,
      Conflict: 40901,
      TooManyRequests: 42901,
      InternalServerError: 50001,
    });
  });

  it("propagates network errors unchanged", async () => {
    const boom = new TypeError("fetch failed");
    const fetch = mockFetch(() => Promise.reject(boom));
    await expect(createClient(fetch).listBuckets()).rejects.toBe(boom);
  });

  it("CdnApiError keeps a cause when given", () => {
    const cause = new Error("inner");
    const error = new CdnApiError("outer", { statusCode: 500, cause });
    expect(error.cause).toBe(cause);
    expect(new CdnApiError("x", { statusCode: 1 }).cause).toBeUndefined();
  });
});

describe("configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("falls back to the NINJAVAULT_CDN_* environment variables", async () => {
    process.env[ENV_BASE_URL] = "https://env.test/prefix";
    process.env[ENV_API_KEY] = "cdn_env_xxxxx";
    process.env[ENV_PUBLIC_BASE_URL] = "https://public-env.test";
    const fetch = mockFetch(() => ok([]));
    const client = new NinjaVaultCdnClient({ fetch });

    await client.listBuckets();
    expect(fetch.single().url).toBe("https://env.test/prefix/api/v1/buckets");
    expect(fetch.single().headers["x-api-key"]).toBe("cdn_env_xxxxx");
    expect(client.buildPublicUrl("a", "b")).toBe("https://public-env.test/public/a/b");
    expect(ENV_BASE_URL).toBe("NINJAVAULT_CDN_BASE_URL");
    expect(ENV_API_KEY).toBe("NINJAVAULT_CDN_API_KEY");
    expect(ENV_PUBLIC_BASE_URL).toBe("NINJAVAULT_CDN_PUBLIC_BASE_URL");
  });

  it("prefers explicit options over environment variables", async () => {
    process.env[ENV_BASE_URL] = "https://env.test";
    process.env[ENV_API_KEY] = "cdn_env_xxxxx";
    const fetch = mockFetch(() => ok([]));
    await new NinjaVaultCdnClient({
      baseUrl: "https://opt.test",
      apiKey: "cdn_opt_xxxxx",
      fetch,
    }).listBuckets();
    expect(fetch.single().url).toBe("https://opt.test/api/v1/buckets");
    expect(fetch.single().headers["x-api-key"]).toBe("cdn_opt_xxxxx");
  });

  it("names the missing setting", async () => {
    delete process.env[ENV_BASE_URL];
    delete process.env[ENV_API_KEY];
    delete process.env[ENV_PUBLIC_BASE_URL];
    const fetch = mockFetch(() => ok([]));

    const noBase = await new NinjaVaultCdnClient({ apiKey: API_KEY, fetch })
      .listBuckets()
      .catch((e: unknown) => e);
    expect(noBase).toBeInstanceOf(CdnConfigurationError);
    expect(noBase).toMatchObject({ name: "CdnConfigurationError", setting: "baseUrl" });
    expect((noBase as Error).message).toContain("NINJAVAULT_CDN_BASE_URL");

    const noKey = await new NinjaVaultCdnClient({ baseUrl: "https://cdn.test", apiKey: "  ", fetch })
      .listBuckets()
      .catch((e: unknown) => e);
    expect(noKey).toMatchObject({ setting: "apiKey" });
    expect((noKey as Error).message).toContain("NINJAVAULT_CDN_API_KEY");

    expect(() => new NinjaVaultCdnClient({}).buildPublicUrl("a", "b")).toThrow(CdnConfigurationError);
    expect(fetch.requests).toHaveLength(0);
  });

  it("rejects invalid URLs and timeouts at construction", () => {
    expect(() => new NinjaVaultCdnClient({ baseUrl: "cdn.test" })).toThrow(
      /baseUrl "cdn.test" is not a valid/,
    );
    expect(() => new NinjaVaultCdnClient({ baseUrl: "ftp://cdn.test" })).toThrow(/http or https/);
    expect(() => new NinjaVaultCdnClient({ publicBaseUrl: "https://cdn.test/?x=1" })).toThrow(
      /query or fragment/,
    );
    expect(() => new NinjaVaultCdnClient({ timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => new NinjaVaultCdnClient({ timeoutMs: Number.POSITIVE_INFINITY })).toThrow(/timeoutMs/);
  });

  it("does not crash when process is undefined (browsers, edge runtimes)", () => {
    const original = globalThis.process;
    // @ts-expect-error: simulate a runtime without `process`
    delete globalThis.process;
    try {
      const client = new NinjaVaultCdnClient({ baseUrl: "https://cdn.test" });
      expect(client.buildPublicUrl("a", "b")).toBe("https://cdn.test/public/a/b");
    } finally {
      globalThis.process = original;
    }
  });

  it("does not crash when reading env throws (Deno without --allow-env)", () => {
    const original = globalThis.process;
    const throwing = {
      get env(): never {
        throw new Error("PermissionDenied");
      },
    };
    Object.defineProperty(globalThis, "process", { value: throwing, configurable: true, writable: true });
    try {
      expect(new NinjaVaultCdnClient({}).baseUrl).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "process", { value: original, configurable: true, writable: true });
    }
  });

  it("reports a missing fetch implementation", async () => {
    const original = globalThis.fetch;
    // @ts-expect-error: simulate a runtime without fetch
    delete globalThis.fetch;
    try {
      const client = new NinjaVaultCdnClient({ baseUrl: "https://cdn.test", apiKey: API_KEY });
      await expect(client.listBuckets()).rejects.toMatchObject({ setting: "fetch" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("timeouts and cancellation", () => {
  const hang = (request: { signal: AbortSignal | null | undefined }): Promise<Response> =>
    new Promise((_, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason as Error));
    });

  it("throws CdnTimeoutError when the SDK timeout elapses", async () => {
    const fetch = mockFetch(hang);
    const error = (await createClient(fetch, { timeoutMs: 20 })
      .listBuckets()
      .catch((e: unknown) => e)) as CdnTimeoutError;
    expect(error).toBeInstanceOf(CdnTimeoutError);
    expect(error).toBeInstanceOf(CdnApiError);
    expect(error.name).toBe("CdnTimeoutError");
    expect(error.timeoutMs).toBe(20);
    expect(error.statusCode).toBe(0);
    expect(error.message).toContain("GET https://cdn.test/api/v1/buckets timed out after 20 ms");
  });

  it("times out even when a custom fetch ignores the signal", async () => {
    const fetch = mockFetch(() => new Promise<Response>(() => undefined));
    await expect(createClient(fetch, { timeoutMs: 20 }).listBuckets()).rejects.toBeInstanceOf(
      CdnTimeoutError,
    );
  });

  it("times out while reading a slow JSON body", async () => {
    const fetch = mockFetch(
      () => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) })),
    );
    await expect(createClient(fetch, { timeoutMs: 20 }).listBuckets()).rejects.toBeInstanceOf(
      CdnTimeoutError,
    );
  });

  it("timeoutMs: 0 disables the timeout", async () => {
    const fetch = mockFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return ok([]);
    });
    await expect(createClient(fetch, { timeoutMs: 0 }).listBuckets()).resolves.toEqual([]);
  });

  it("propagates a caller abort as the standard AbortError", async () => {
    const fetch = mockFetch(hang);
    const controller = new AbortController();
    const promise = createClient(fetch).listBuckets({ signal: controller.signal });
    controller.abort();
    const error = (await promise.catch((e: unknown) => e)) as DOMException;
    expect(error.name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(CdnApiError);
  });

  it("propagates a custom abort reason", async () => {
    const fetch = mockFetch(hang);
    const controller = new AbortController();
    const reason = new Error("user navigated away");
    const promise = createClient(fetch).listBuckets({ signal: controller.signal });
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
  });

  it("rejects immediately for an already-aborted signal without sending", async () => {
    const fetch = mockFetch(() => ok([]));
    const signal = AbortSignal.abort();
    await expect(createClient(fetch).listBuckets({ signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch.requests).toHaveLength(0);
  });

  it("does not time out a download that is still streaming, but honours the caller's signal", async () => {
    const controller = new AbortController();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = mockFetch((request) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
          request.signal?.addEventListener("abort", () => c.error(request.signal?.reason));
        },
      });
      return new Response(body);
    });
    const download = await createClient(fetch, { timeoutMs: 20 }).download("b", "k", {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    streamController.enqueue(new Uint8Array([1]));
    const reader = download.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));

    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes an AbortSignal to fetch", async () => {
    const fetch = mockFetch(() => ok([]));
    await createClient(fetch).listBuckets();
    expect(fetch.single().signal).toBeInstanceOf(AbortSignal);
  });
});

describe("hooks", () => {
  it("receives redacted headers, status and duration, and can add headers", async () => {
    const requests: CdnRequestContext[] = [];
    const responses: CdnResponseContext[] = [];
    const fetch = mockFetch(() => ok([]));
    await createClient(fetch, {
      hooks: {
        onRequest(context) {
          requests.push(context);
          context.setHeader("X-Correlation-Id", "corr-123");
          context.setHeader("x-api-key", "cdn_hijack_xxxxx");
        },
        async onResponse(context) {
          await Promise.resolve();
          responses.push(context);
        },
      },
    }).listBuckets();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("https://cdn.test/api/v1/buckets");
    expect(requests[0]!.headers["X-Api-Key"]).toBe("[REDACTED]");
    expect(JSON.stringify(requests[0]!.headers)).not.toContain(API_KEY);

    const sent = fetch.single();
    expect(sent.headers["x-correlation-id"]).toBe("corr-123");
    expect(sent.headers["x-api-key"]).toBe(API_KEY);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe(200);
    expect(responses[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(responses[0]!.headers["X-Api-Key"]).toBe("[REDACTED]");
    expect(responses[0]!.headers["X-Correlation-Id"]).toBe("corr-123");
  });

  it("onError receives the thrown error and status, with the key redacted", async () => {
    const errors: CdnErrorContext[] = [];
    const fetch = mockFetch(() => fail(404, { errorCode: 40401, message: "Not found", traceId: "t" }));
    const thrown = await createClient(fetch, { hooks: { onError: (c) => void errors.push(c) } })
      .getMetadata("b", "k")
      .catch((e: unknown) => e);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.status).toBe(404);
    expect(errors[0]!.error).toBe(thrown);
    expect(errors[0]!.headers["X-Api-Key"]).toBe("[REDACTED]");
  });

  it("onError fires for timeouts with status undefined", async () => {
    const errors: CdnErrorContext[] = [];
    const fetch = mockFetch(() => new Promise<Response>(() => undefined));
    await createClient(fetch, { timeoutMs: 10, hooks: { onError: (c) => void errors.push(c) } })
      .listBuckets()
      .catch(() => undefined);
    expect(errors[0]!.status).toBeUndefined();
    expect(errors[0]!.error).toBeInstanceOf(CdnTimeoutError);
  });

  it("swallows errors thrown by hooks", async () => {
    const fetch = mockFetch(() => ok([]));
    const client = createClient(fetch, {
      hooks: {
        onRequest: () => {
          throw new Error("logger down");
        },
        onResponse: () => Promise.reject(new Error("logger down")),
      },
    });
    await expect(client.listBuckets()).resolves.toEqual([]);
  });
});

describe("version", () => {
  it("SDK_VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
