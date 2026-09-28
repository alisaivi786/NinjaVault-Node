/**
 * Percent-encodes a value exactly like .NET's `Uri.EscapeDataString` (RFC 3986): everything except the
 * unreserved characters `A-Z a-z 0-9 - _ . ~` is escaped. `encodeURIComponent` alone leaves `! ' ( ) *`.
 */
export function escapeDataString(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function isBlank(value: string | null | undefined): value is null | undefined | "" {
  return value === undefined || value === null || value.trim() === "";
}

export function requireNonBlank(value: unknown, name: string): string {
  if (typeof value !== "string" || isBlank(value)) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

/** Encodes one path segment (the bucket). */
export function encodePathSegment(value: string, name: string): string {
  return escapeDataString(requireNonBlank(value, name));
}

/** Encodes an object key segment by segment, dropping empty segments (`a//b/` becomes `a/b`). */
export function encodeObjectKey(objectKey: string): string {
  requireNonBlank(objectKey, "objectKey");
  const segments = objectKey.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new TypeError("objectKey must contain at least one non-empty segment.");
  }
  return segments.map(escapeDataString).join("/");
}

/** Joins a base URL (which may carry a path prefix) and an absolute path without doubling slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + path;
}

export type QueryValue = string | number | bigint | boolean | Date | null | undefined;

/** Builds `?a=1&b=2`, skipping `undefined`/`null`/blank values. Dates become ISO-8601 UTC. */
export function buildQuery(params: ReadonlyArray<readonly [string, QueryValue]>): string {
  const parts: string[] = [];
  for (const [name, value] of params) {
    if (value === undefined || value === null) {
      continue;
    }
    let text: string;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new TypeError(`${name} is not a valid date.`);
      }
      text = value.toISOString();
    } else {
      text = String(value);
    }
    if (text.trim() === "") {
      continue;
    }
    parts.push(`${escapeDataString(name)}=${escapeDataString(text)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * Parses `Retry-After` (delta seconds or HTTP-date) into milliseconds from `now`. Returns `undefined` when
 * the header is absent or unparseable; a date in the past yields `0`.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) {
    return undefined;
  }
  const value = header.trim();
  if (value === "") {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
}

/** Extracts the media type from `Content-Type` (drops `; charset=...`). */
export function parseMediaType(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const mediaType = header.split(";")[0]?.trim() ?? "";
  return mediaType === "" ? null : mediaType;
}

/**
 * Reads the file name from `Content-Disposition`, preferring RFC 5987 `filename*` over `filename`, the same
 * precedence as .NET's `ContentDisposition.FileNameStar ?? FileName`.
 */
export function parseContentDispositionFileName(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const params = parseHeaderParameters(header);

  const extended = params.get("filename*");
  if (extended !== undefined) {
    const decoded = decodeRfc5987(extended);
    if (decoded !== null && decoded !== "") {
      return decoded;
    }
  }

  const plain = params.get("filename");
  return plain === undefined || plain === "" ? null : plain;
}

function parseHeaderParameters(header: string): Map<string, string> {
  const params = new Map<string, string>();
  // name=token | name="quoted \" string"
  const pattern = /;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (const match of header.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || params.has(name)) {
      continue;
    }
    const quoted = match[2];
    const value = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : (match[3] ?? "").trim();
    params.set(name, value);
  }
  return params;
}

function decodeRfc5987(value: string): string | null {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  const charset = match?.[1]?.toLowerCase();
  const encoded = match?.[2];
  if (encoded === undefined) {
    return null;
  }
  try {
    if (charset === "utf-8" || charset === "") {
      return decodeURIComponent(encoded);
    }
    // ISO-8859-1 (the only other charset RFC 5987 requires): each %XX byte is one code point.
    return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  } catch {
    return null;
  }
}

/** Parses an optional integer header such as `Content-Length`. */
export function parseLength(header: string | null): number | null {
  if (header === null || !/^\s*\d+\s*$/.test(header)) {
    return null;
  }
  return Number(header);
}

/** Reads an environment variable without crashing where `process` does not exist (browsers, edge, Deno). */
export function readEnv(name: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const value = proc?.env?.[name];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    // Deno without --allow-env throws on access.
    return undefined;
  }
}
