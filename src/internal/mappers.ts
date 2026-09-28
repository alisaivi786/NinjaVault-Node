import type {
  AccessBucket,
  AccessContext,
  Bucket,
  FileCategorySummary,
  FileObject,
  FileSummary,
  PagedResult,
  PresignBatchResult,
  PresignedTarget,
  PresignedUrl,
  PresignFailure,
  UploadResult,
} from "../types.js";

/** A JSON object from the wire. Values are `unknown` until mapped. */
export type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Objects/arrays/undefined/null are not valid for a string field.
  return "";
}

function strOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : str(value);
}

function num(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function numOrNull(value: unknown): number | null {
  return value === undefined || value === null ? null : num(value);
}

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Parses a server timestamp. The server emits ISO-8601; a value without an offset (a .NET `DateTime` of
 * unspecified kind) is a UTC timestamp, so `Z` is appended rather than letting JS treat it as local time.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return new Date(value);
  }
  const text = str(value).trim();
  if (text === "") {
    return new Date(Number.NaN);
  }
  const hasOffset = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const isDateTime = /^\d{4}-\d{2}-\d{2}T/.test(text);
  return new Date(isDateTime && !hasOffset ? `${text}Z` : text);
}

function pick(raw: Json, ...names: string[]): unknown {
  for (const name of names) {
    if (raw[name] !== undefined) {
      return raw[name];
    }
  }
  return undefined;
}

export function mapAccessBucket(value: unknown): AccessBucket {
  const raw = asObject(value);
  return { name: str(raw.name), visibility: str(raw.visibility) };
}

export function mapAccessContext(value: unknown): AccessContext {
  const raw = asObject(value);
  return {
    name: str(raw.name),
    isUnrestricted: bool(raw.isUnrestricted),
    isAdmin: bool(raw.isAdmin),
    allowedBuckets: asArray(raw.allowedBuckets).map(str),
    allowedTenantIds: asArray(raw.allowedTenantIds).map(str),
    buckets: asArray(raw.buckets).map(mapAccessBucket),
  };
}

export function mapBucket(value: unknown): Bucket {
  const raw = asObject(value);
  return {
    name: str(raw.name),
    visibility: str(raw.visibility),
    fileCount: num(raw.fileCount),
    totalSizeBytes: num(raw.totalSizeBytes),
  };
}

export function mapBuckets(value: unknown): Bucket[] {
  return asArray(value).map(mapBucket);
}

export function mapUploadResult(value: unknown): UploadResult {
  const raw = asObject(value);
  return {
    id: str(raw.id),
    bucket: str(raw.bucket),
    objectKey: str(raw.objectKey),
    originalFileName: str(raw.originalFileName),
    contentType: str(raw.contentType),
    sizeBytes: num(raw.sizeBytes),
    visibility: str(raw.visibility),
    url: str(raw.url),
    viewUrl: strOrNull(raw.viewUrl),
  };
}

export function mapFileObject(value: unknown): FileObject {
  const raw = asObject(value);
  return {
    id: str(raw.id),
    tenantId: str(raw.tenantId),
    ownerId: numOrNull(raw.ownerId),
    bucket: str(raw.bucket),
    objectKey: str(raw.objectKey),
    originalFileName: str(raw.originalFileName),
    contentType: str(raw.contentType),
    sizeBytes: num(raw.sizeBytes),
    checksum: strOrNull(raw.checksum),
    visibility: str(raw.visibility),
    extension: strOrNull(raw.extension),
    category: str(raw.category),
    thumbnailStatus: str(raw.thumbnailStatus),
    thumbnailUrl: strOrNull(raw.thumbnailUrl),
    // The server property is CreatedAtUTC, serialized as "createdAtUTC".
    createdAtUtc: toDate(pick(raw, "createdAtUTC", "createdAtUtc")),
    url: str(raw.url),
    viewUrl: strOrNull(raw.viewUrl),
  };
}

export function mapPagedFiles(value: unknown): PagedResult<FileObject> {
  const raw = asObject(value);
  return {
    items: asArray(raw.items).map(mapFileObject),
    totalCount: num(raw.totalCount),
    page: num(raw.page),
    pageSize: num(raw.pageSize),
  };
}

function mapCategorySummary(value: unknown): FileCategorySummary {
  const raw = asObject(value);
  return {
    category: str(raw.category),
    fileCount: num(raw.fileCount),
    totalSizeBytes: num(raw.totalSizeBytes),
  };
}

export function mapFileSummary(value: unknown): FileSummary {
  const raw = asObject(value);
  return {
    totalFileCount: num(raw.totalFileCount),
    totalSizeBytes: num(raw.totalSizeBytes),
    categories: asArray(raw.categories).map(mapCategorySummary),
  };
}

export function mapPresignedUrl(value: unknown): PresignedUrl {
  const raw = asObject(value);
  return { url: str(raw.url), expiresAtUtc: toDate(pick(raw, "expiresAtUtc", "expiresAtUTC")) };
}

function mapPresignedTarget(value: unknown): PresignedTarget {
  const raw = asObject(value);
  return {
    bucket: str(raw.bucket),
    objectKey: str(raw.objectKey),
    url: str(raw.url),
    expiresAtUtc: toDate(pick(raw, "expiresAtUtc", "expiresAtUTC")),
  };
}

function mapPresignFailure(value: unknown): PresignFailure {
  const raw = asObject(value);
  return { bucket: str(raw.bucket), objectKey: str(raw.objectKey), reason: str(raw.reason) };
}

export function mapPresignBatchResult(value: unknown): PresignBatchResult {
  const raw = asObject(value);
  return {
    succeeded: asArray(raw.succeeded).map(mapPresignedTarget),
    failed: asArray(raw.failed).map(mapPresignFailure),
  };
}

/** The server's error object inside a failure envelope. */
export interface WireError {
  errorCode: number | undefined;
  message: string | undefined;
  description: string | undefined;
  traceId: string | undefined;
  details: Record<string, string[]> | undefined;
}

export function mapWireError(value: unknown): WireError | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Json;
  const code = raw.errorCode;
  const rawDetails = raw.details;
  let details: Record<string, string[]> | undefined;
  if (typeof rawDetails === "object" && rawDetails !== null && !Array.isArray(rawDetails)) {
    details = {};
    for (const [field, errors] of Object.entries(rawDetails as Json)) {
      details[field] = Array.isArray(errors) ? errors.map(str) : [str(errors)];
    }
  }
  const optionalString = (v: unknown): string | undefined =>
    v === undefined || v === null ? undefined : str(v);
  return {
    errorCode: code === undefined || code === null ? undefined : num(code),
    message: optionalString(raw.message),
    description: optionalString(raw.description),
    // Ninja.Kit's ApiError names it "traceId"; accept "correlationId" too for older gateways.
    traceId: optionalString(pick(raw, "traceId", "correlationId")),
    details,
  };
}
