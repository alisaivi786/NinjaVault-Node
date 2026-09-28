import { describe, expect, it } from "vitest";
import {
  BucketVisibility,
  CdnApiError,
  FileCategory,
  FileSortBy,
  NinjaVaultCdnClient,
  SDK_VERSION,
} from "../src/index.js";
import { API_KEY, FILE_OBJECT, createClient, json, mockFetch, ok } from "./helpers.js";

describe("routes, headers and envelopes", () => {
  it("getAccessContext calls GET /api/v1/me with the API key and maps the scope", async () => {
    const fetch = mockFetch(() =>
      ok({
        name: "billing-service",
        isUnrestricted: false,
        isAdmin: false,
        allowedBuckets: ["documents"],
        allowedTenantIds: ["42", "7d7c1b4e-7a8e-4c56-9f1b-8f7f2d3f4a11"],
        buckets: [{ name: "documents", visibility: "Private" }],
      }),
    );
    const access = await createClient(fetch).getAccessContext();

    const request = fetch.single();
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://cdn.test/api/v1/me");
    expect(request.headers["x-api-key"]).toBe(API_KEY);
    expect(request.headers["user-agent"]).toBe(`ninjavault-cdn-node/${SDK_VERSION}`);
    expect(request.headers.accept).toBe("application/json");
    expect(access).toEqual({
      name: "billing-service",
      isUnrestricted: false,
      isAdmin: false,
      allowedBuckets: ["documents"],
      allowedTenantIds: ["42", "7d7c1b4e-7a8e-4c56-9f1b-8f7f2d3f4a11"],
      buckets: [{ name: "documents", visibility: BucketVisibility.Private }],
    });
  });

  it('parses allowedTenantIds sent as JSON strings (live server shape: ["1"])', async () => {
    const fetch = mockFetch(() =>
      ok({
        name: "k",
        isUnrestricted: false,
        isAdmin: false,
        allowedBuckets: ["documents"],
        allowedTenantIds: ["1"],
        // The live server can list buckets here that are not in allowedBuckets; passed through unchanged.
        buckets: [{ name: "other", visibility: "Public" }],
      }),
    );
    const access = await createClient(fetch).getAccessContext();
    expect(access.allowedTenantIds).toEqual(["1"]);
    expect(access.buckets).toEqual([{ name: "other", visibility: "Public" }]);
  });

  it("handles an empty bucket list (restricted key)", async () => {
    const fetch = mockFetch(() => ok([]));
    expect(await createClient(fetch).listBuckets()).toEqual([]);
  });

  it("getAccessContext tolerates missing arrays and numeric tenant ids", async () => {
    const fetch = mockFetch(() => ok({ name: "k", isUnrestricted: true, allowedTenantIds: [42] }));
    const access = await createClient(fetch).getAccessContext();
    expect(access.allowedBuckets).toEqual([]);
    expect(access.allowedTenantIds).toEqual(["42"]);
    expect(access.buckets).toEqual([]);
    expect(access.isAdmin).toBe(false);
  });

  it("listBuckets calls GET /api/v1/buckets and reads the envelope", async () => {
    const fetch = mockFetch(() =>
      ok([{ name: "documents", visibility: "Private", fileCount: 12, totalSizeBytes: 2048000 }]),
    );
    const buckets = await createClient(fetch).listBuckets();

    expect(fetch.single().url).toBe("https://cdn.test/api/v1/buckets");
    expect(buckets).toEqual([
      { name: "documents", visibility: "Private", fileCount: 12, totalSizeBytes: 2048000 },
    ]);
  });

  it("listBuckets returns [] when data is not an array", async () => {
    const fetch = mockFetch(() => ok({}));
    expect(await createClient(fetch).listBuckets()).toEqual([]);
  });

  it("getMetadata calls GET /api/v1/file-metadata/{bucket}/{objectKey} and converts dates", async () => {
    const fetch = mockFetch(() => ok(FILE_OBJECT));
    const file = await createClient(fetch).getMetadata("documents", FILE_OBJECT.objectKey);

    expect(fetch.single().url).toBe(
      "https://cdn.test/api/v1/file-metadata/documents/owner-token/invoices/2026/file.pdf",
    );
    expect(file.createdAtUtc).toBeInstanceOf(Date);
    expect(file.createdAtUtc.toISOString()).toBe("2026-07-26T15:00:00.000Z");
    expect(file.ownerId).toBe(1001);
    expect(file.tenantId).toBe("42");
    expect(file.category).toBe(FileCategory.Document);
    expect(file.checksum).toBe("abc123");
    expect(file.viewUrl).toBeNull();
    expect(file.thumbnailUrl).toBeNull();
  });

  it("treats a timestamp without an offset as UTC", async () => {
    const fetch = mockFetch(() => ok({ ...FILE_OBJECT, createdAtUTC: "2026-07-26T15:00:00.123" }));
    const file = await createClient(fetch).getMetadata("documents", "a.pdf");
    expect(file.createdAtUtc.toISOString()).toBe("2026-07-26T15:00:00.123Z");
  });

  it("maps numeric-string ids and missing optional fields defensively", async () => {
    const fetch = mockFetch(() =>
      ok({ id: "x", tenantId: 42, ownerId: "1001", sizeBytes: "15", createdAtUtc: 0 }),
    );
    const file = await createClient(fetch).getMetadata("documents", "a.pdf");
    expect(file.tenantId).toBe("42");
    expect(file.ownerId).toBe(1001);
    expect(file.sizeBytes).toBe(15);
    expect(file.checksum).toBeNull();
    expect(file.extension).toBeNull();
    expect(file.bucket).toBe("");
    expect(file.createdAtUtc.getTime()).toBe(0);
  });

  it("gives an Invalid Date (not a throw) for an unparseable or missing timestamp", async () => {
    const fetch = mockFetch(() => ok({ ...FILE_OBJECT, createdAtUTC: null, sizeBytes: "n/a" }));
    const file = await createClient(fetch).getMetadata("documents", "a.pdf");
    expect(Number.isNaN(file.createdAtUtc.getTime())).toBe(true);
    expect(file.sizeBytes).toBe(0);
  });

  it("keeps unknown enum values from newer servers", async () => {
    const fetch = mockFetch(() =>
      ok({ ...FILE_OBJECT, visibility: "Internal", category: "Archive", thumbnailStatus: "Queued" }),
    );
    const file = await createClient(fetch).getMetadata("documents", "a.pdf");
    expect(file.visibility).toBe("Internal");
    expect(file.category).toBe("Archive");
    expect(file.thumbnailStatus).toBe("Queued");
  });

  it("getSummary calls /api/v1/files/summary with and without a bucket", async () => {
    const summary = {
      totalFileCount: 3,
      totalSizeBytes: 300,
      categories: [{ category: "Image", fileCount: 3, totalSizeBytes: 300 }],
    };
    const fetch = mockFetch(() => ok(summary));
    const client = createClient(fetch);

    expect(await client.getSummary()).toEqual(summary);
    await client.getSummary("my docs");
    await client.getSummary("   ");

    expect(fetch.requests.map((r) => r.url)).toEqual([
      "https://cdn.test/api/v1/files/summary",
      "https://cdn.test/api/v1/files/summary?bucket=my%20docs",
      "https://cdn.test/api/v1/files/summary",
    ]);
  });

  it("getSummary tolerates a missing categories array", async () => {
    const fetch = mockFetch(() => ok({ totalFileCount: 0, totalSizeBytes: 0 }));
    expect((await createClient(fetch).getSummary()).categories).toEqual([]);
  });

  it("keeps a path prefix on baseUrl (with or without trailing slash)", async () => {
    const fetch = mockFetch(() => ok([]));
    await createClient(fetch, { baseUrl: "https://gateway.test/cdn/" }).listBuckets();
    await createClient(fetch, { baseUrl: "https://gateway.test/cdn" }).listBuckets();
    expect(fetch.requests.map((r) => r.url)).toEqual([
      "https://gateway.test/cdn/api/v1/buckets",
      "https://gateway.test/cdn/api/v1/buckets",
    ]);
  });

  it("uses a custom userAgent when given", async () => {
    const fetch = mockFetch(() => ok([]));
    await createClient(fetch, { userAgent: "my-app/1.0" }).listBuckets();
    expect(fetch.single().headers["user-agent"]).toBe("my-app/1.0");
  });

  it("exposes the version statically and the resolved baseUrl", () => {
    expect(NinjaVaultCdnClient.version).toBe(SDK_VERSION);
    expect(createClient(mockFetch(() => ok([]))).baseUrl).toBe("https://cdn.test");
  });

  it("uses globalThis.fetch when no fetch option is given", async () => {
    const original = globalThis.fetch;
    const fetch = mockFetch(() => ok([]));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await new NinjaVaultCdnClient({ baseUrl: "https://cdn.test", apiKey: API_KEY }).listBuckets();
    } finally {
      globalThis.fetch = original;
    }
    expect(fetch.single().url).toBe("https://cdn.test/api/v1/buckets");
  });
});

describe("envelope handling", () => {
  it("throws CdnApiError for a success:false envelope on HTTP 200", async () => {
    const fetch = mockFetch(() =>
      json({ success: false, error: { errorCode: 40301, message: "Forbidden", traceId: "t-1" } }),
    );
    const error = await createClient(fetch)
      .listBuckets()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CdnApiError);
    expect(error).toMatchObject({
      statusCode: 200,
      errorCode: 40301,
      correlationId: "t-1",
      message: "Forbidden",
    });
  });

  it("uses a default message when a failure envelope has no error object", async () => {
    const fetch = mockFetch(() => json({ success: false }));
    await expect(createClient(fetch).listBuckets()).rejects.toMatchObject({
      message: "CDN request failed.",
      errorCode: undefined,
    });
  });

  it("throws on an empty 200 body", async () => {
    const fetch = mockFetch(() => new Response("", { status: 200 }));
    await expect(createClient(fetch).listBuckets()).rejects.toThrow("CDN response body was empty.");
  });

  it("throws on a non-JSON 200 body", async () => {
    const fetch = mockFetch(() => new Response("<html>proxy</html>", { status: 200 }));
    await expect(createClient(fetch).listBuckets()).rejects.toMatchObject({
      message: "CDN response was not a valid JSON envelope.",
      description: "<html>proxy</html>",
    });
  });

  it("throws on JSON that is not an envelope", async () => {
    const fetch = mockFetch(() => json([1, 2, 3]));
    await expect(createClient(fetch).listBuckets()).rejects.toThrow("not a valid JSON envelope");
    const fetch2 = mockFetch(() => json({ data: [] }));
    await expect(createClient(fetch2).listBuckets()).rejects.toThrow("not a valid JSON envelope");
  });

  it("throws when a success envelope carries no data", async () => {
    const fetch = mockFetch(() => json({ success: true, data: null }));
    await expect(createClient(fetch).getAccessContext()).rejects.toThrow("contained no data");
  });
});

describe("listFiles query building", () => {
  it("sends no query string when no filters are given", async () => {
    const fetch = mockFetch(() => ok({ items: [], totalCount: 0, page: 1, pageSize: 50 }));
    const client = createClient(fetch);
    await client.listFiles();
    await client.listFiles({});
    expect(fetch.requests.map((r) => r.url)).toEqual([
      "https://cdn.test/api/v1/files",
      "https://cdn.test/api/v1/files",
    ]);
  });

  it("uses the server's query names and ISO-8601 UTC dates", async () => {
    const fetch = mockFetch(() => ok({ items: [FILE_OBJECT], totalCount: 1, page: 2, pageSize: 25 }));
    const page = await createClient(fetch).listFiles({
      bucket: "documents",
      tenantId: 42,
      ownerId: 1001n,
      objectKeyPrefix: "owner-token/invoices",
      fileNameContains: "inv oice",
      contentType: "application/pdf",
      category: FileCategory.Document,
      visibility: BucketVisibility.Private,
      createdFromUtc: new Date("2026-01-01T00:00:00+02:00"),
      createdToUtc: "2026-02-01T00:00:00Z",
      includeDeleted: false,
      sortBy: FileSortBy.CreatedAtUtc,
      sortDescending: false,
      page: 2,
      pageSize: 25,
    });

    expect(fetch.single().url).toBe(
      "https://cdn.test/api/v1/files?bucket=documents&tenantId=42&ownerId=1001" +
        "&objectKeyPrefix=owner-token%2Finvoices&fileNameContains=inv%20oice" +
        "&contentType=application%2Fpdf&category=Document&visibility=Private" +
        "&createdFromUTC=2025-12-31T22%3A00%3A00.000Z&createdToUTC=2026-02-01T00%3A00%3A00.000Z" +
        "&includeDeleted=false&sortBy=CreatedAtUTC&sortDescending=false&page=2&pageSize=25",
    );
    expect(page.totalCount).toBe(1);
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(25);
    expect(page.items[0]?.createdAtUtc).toBeInstanceOf(Date);
    expect(page.items[0]?.objectKey).toBe(FILE_OBJECT.objectKey);
  });

  it("skips blank strings and rejects invalid dates", async () => {
    const fetch = mockFetch(() => ok({ items: [], totalCount: 0, page: 1, pageSize: 50 }));
    const client = createClient(fetch);
    await client.listFiles({ bucket: "  ", tenantId: "", includeDeleted: true, createdFromUtc: "" });
    expect(fetch.single().url).toBe("https://cdn.test/api/v1/files?includeDeleted=true");
    await expect(client.listFiles({ createdFromUtc: "not a date" })).rejects.toThrow(TypeError);
  });

  it("maps an empty page defensively", async () => {
    const fetch = mockFetch(() => ok({}));
    expect(await createClient(fetch).listFiles()).toEqual({ items: [], totalCount: 0, page: 0, pageSize: 0 });
  });
});

describe("percent-encoding", () => {
  it("encodes the bucket and each object-key segment like Uri.EscapeDataString", async () => {
    const fetch = mockFetch(() => ok(FILE_OBJECT));
    await createClient(fetch).getMetadata("my docs", "owner token/a file (1)!*'.pdf");
    expect(fetch.single().url).toBe(
      "https://cdn.test/api/v1/file-metadata/my%20docs/owner%20token/a%20file%20%281%29%21%2A%27.pdf",
    );
  });

  it("skips empty object-key segments and encodes unicode, ?, # and %", async () => {
    const fetch = mockFetch(() => ok(FILE_OBJECT));
    await createClient(fetch).getMetadata("docs", "/a//b?c#d%e/ümlaut.pdf/");
    expect(fetch.single().url).toBe(
      "https://cdn.test/api/v1/file-metadata/docs/a/b%3Fc%23d%25e/%C3%BCmlaut.pdf",
    );
  });

  it("rejects blank bucket / object keys and keys made only of slashes", async () => {
    const client = createClient(mockFetch(() => ok(FILE_OBJECT)));
    await expect(client.getMetadata("", "a.pdf")).rejects.toThrow("bucket must be a non-empty string.");
    await expect(client.getMetadata("docs", "  ")).rejects.toThrow("objectKey must be a non-empty string.");
    await expect(client.getMetadata("docs", "///")).rejects.toThrow("at least one non-empty segment");
    await expect(client.download(" ", "a")).rejects.toThrow(TypeError);
    await expect(client.delete("docs", "")).rejects.toThrow(TypeError);
    // @ts-expect-error: runtime guard for JS callers
    await expect(client.getMetadata(undefined, "a")).rejects.toThrow(TypeError);
  });
});

describe("delete", () => {
  it("sends DELETE and accepts 204 No Content", async () => {
    const fetch = mockFetch(() => new Response(null, { status: 204 }));
    await expect(createClient(fetch).delete("documents", "a.pdf")).resolves.toBeUndefined();
    const request = fetch.single();
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe("https://cdn.test/api/v1/files/documents/a.pdf");
  });

  it("accepts the server's success envelope with null data", async () => {
    const fetch = mockFetch(() => ok(null));
    await expect(createClient(fetch).delete("documents", "a.pdf")).resolves.toBeUndefined();
  });

  it("ignores a non-JSON 2xx body", async () => {
    const fetch = mockFetch(() => new Response("deleted", { status: 200 }));
    await expect(createClient(fetch).delete("documents", "a.pdf")).resolves.toBeUndefined();
  });

  it("throws when the envelope reports failure", async () => {
    const fetch = mockFetch(() =>
      json({ success: false, error: { errorCode: 40401, message: "Not found", traceId: "corr-3" } }),
    );
    await expect(createClient(fetch).delete("documents", "a.pdf")).rejects.toMatchObject({
      name: "CdnApiError",
      errorCode: 40401,
      correlationId: "corr-3",
    });
  });
});

describe("presign", () => {
  it("createPresignedUrl posts JSON and converts expiresAtUtc", async () => {
    const fetch = mockFetch(() =>
      ok({
        url: "https://cdn.test/files/presigned/documents/a.pdf?expires=1&sig=abc",
        expiresAtUtc: "2026-07-26T15:20:00+00:00",
      }),
    );
    const result = await createClient(fetch).createPresignedUrl({
      bucket: "documents",
      objectKey: "a.pdf",
      expirySeconds: 300,
    });

    const request = fetch.single();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://cdn.test/api/v1/files/presign");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body as string)).toEqual({
      bucket: "documents",
      objectKey: "a.pdf",
      expirySeconds: 300,
    });
    expect(result.url).toBe("https://cdn.test/files/presigned/documents/a.pdf?expires=1&sig=abc");
    expect(result.expiresAtUtc.toISOString()).toBe("2026-07-26T15:20:00.000Z");
  });

  it("createPresignedUrl omits expirySeconds when not given and validates input", async () => {
    const fetch = mockFetch(() => ok({ url: "u", expiresAtUtc: "2026-07-26T15:20:00Z" }));
    const client = createClient(fetch);
    await client.createPresignedUrl({ bucket: "documents", objectKey: "a.pdf" });
    expect(JSON.parse(fetch.single().body as string)).toEqual({ bucket: "documents", objectKey: "a.pdf" });
    await expect(client.createPresignedUrl({ bucket: "", objectKey: "a" })).rejects.toThrow(TypeError);
    // @ts-expect-error: runtime guard for JS callers
    await expect(client.createPresignedUrl(null)).rejects.toThrow("request is required.");
  });

  it("createPresignedUrls posts the batch and maps succeeded + failed", async () => {
    const fetch = mockFetch(() =>
      ok({
        succeeded: [
          {
            bucket: "documents",
            objectKey: "a.pdf",
            url: "https://cdn.test/p/a",
            expiresAtUtc: "2026-07-26T15:20:00Z",
          },
        ],
        failed: [{ bucket: "documents", objectKey: "b.pdf", reason: "NotFound" }],
      }),
    );
    const result = await createClient(fetch).createPresignedUrls({
      targets: [
        { bucket: "documents", objectKey: "a.pdf" },
        { bucket: "documents", objectKey: "b.pdf" },
      ],
      expirySeconds: 600,
    });

    const request = fetch.single();
    expect(request.url).toBe("https://cdn.test/api/v1/files/presign/batch");
    expect(JSON.parse(request.body as string)).toEqual({
      targets: [
        { bucket: "documents", objectKey: "a.pdf" },
        { bucket: "documents", objectKey: "b.pdf" },
      ],
      expirySeconds: 600,
    });
    expect(result.succeeded[0]?.expiresAtUtc).toBeInstanceOf(Date);
    expect(result.failed).toEqual([{ bucket: "documents", objectKey: "b.pdf", reason: "NotFound" }]);
  });

  it("createPresignedUrls validates targets and tolerates missing arrays", async () => {
    const fetch = mockFetch(() => ok({}));
    const client = createClient(fetch);
    expect(await client.createPresignedUrls({ targets: [] })).toEqual({ succeeded: [], failed: [] });
    // @ts-expect-error: runtime guard for JS callers
    await expect(client.createPresignedUrls({})).rejects.toThrow("request.targets must be an array.");
  });
});

describe("buildPublicUrl", () => {
  it("uses publicBaseUrl and encodes segments", () => {
    const client = createClient(mockFetch(() => ok(null)));
    expect(client.buildPublicUrl("public assets", "owner token/logo one.png")).toBe(
      "https://public.test/public/public%20assets/owner%20token/logo%20one.png",
    );
  });

  it("falls back to baseUrl (keeping its path prefix) when publicBaseUrl is not set", () => {
    const client = new NinjaVaultCdnClient({ baseUrl: "https://gateway.test/cdn/", apiKey: API_KEY });
    expect(client.buildPublicUrl("assets", "a/b.png")).toBe("https://gateway.test/cdn/public/assets/a/b.png");
  });

  it("never produces /public/public/", () => {
    for (const publicBaseUrl of [
      "https://cdn.example.com",
      "https://cdn.example.com/",
      "https://cdn.example.com/public",
      "https://cdn.example.com/public/",
    ]) {
      const client = new NinjaVaultCdnClient({ publicBaseUrl });
      const url = client.buildPublicUrl("assets", "logo.png");
      expect(url).toBe("https://cdn.example.com/public/assets/logo.png");
      expect(url).not.toContain("/public/public/");
    }
  });

  it("does not need an API key and makes no request", () => {
    const fetch = mockFetch(() => ok(null));
    const client = new NinjaVaultCdnClient({ baseUrl: "https://cdn.test", fetch });
    expect(client.buildPublicUrl("assets", "x.png")).toBe("https://cdn.test/public/assets/x.png");
    expect(fetch.requests).toHaveLength(0);
  });
});
