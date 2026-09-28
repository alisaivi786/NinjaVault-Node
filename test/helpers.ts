import { NinjaVaultCdnClient, type NinjaVaultCdnClientOptions } from "../src/index.js";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null | undefined;
}

export type Responder = (request: CapturedRequest) => Response | Promise<Response>;

export interface MockFetch {
  (input: string, init: RequestInit): Promise<Response>;
  requests: CapturedRequest[];
  /** The only captured request (fails if there is not exactly one). */
  single(): CapturedRequest;
}

export function mockFetch(responder: Responder): MockFetch {
  const requests: CapturedRequest[] = [];
  const fn = (async (input: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const request: CapturedRequest = {
      url: input,
      method: init.method ?? "GET",
      headers,
      body: init.body,
      signal: init.signal,
    };
    requests.push(request);
    return responder(request);
  }) as MockFetch;
  fn.requests = requests;
  fn.single = () => {
    if (requests.length !== 1) {
      throw new Error(`Expected exactly one request, got ${requests.length}.`);
    }
    return requests[0]!;
  };
  return fn;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function ok(data: unknown, headers: Record<string, string> = {}): Response {
  return json({ success: true, data, error: null }, 200, headers);
}

export function fail(
  status: number,
  error: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return json({ success: false, data: null, error }, status, headers);
}

export const API_KEY = "cdn_test_xxxxx";

export function createClient(
  fetch: MockFetch,
  options: Partial<NinjaVaultCdnClientOptions> = {},
): NinjaVaultCdnClient {
  return new NinjaVaultCdnClient({
    baseUrl: "https://cdn.test",
    apiKey: API_KEY,
    publicBaseUrl: "https://public.test",
    fetch,
    ...options,
  });
}

export const FILE_OBJECT = {
  id: "1cf8e5e6-21f0-49a5-90b1-5c0f985c9df7",
  tenantId: "42",
  ownerId: 1001,
  bucket: "documents",
  objectKey: "owner-token/invoices/2026/file.pdf",
  originalFileName: "invoice.pdf",
  contentType: "application/pdf",
  sizeBytes: 7,
  checksum: "abc123",
  visibility: "Private",
  extension: "pdf",
  category: "Document",
  thumbnailStatus: "NotApplicable",
  thumbnailUrl: null,
  createdAtUTC: "2026-07-26T15:00:00Z",
  url: "https://cdn.test/api/v1/files/documents/owner-token/invoices/2026/file.pdf",
  viewUrl: null,
};
