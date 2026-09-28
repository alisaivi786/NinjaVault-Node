/**
 * Enum-like values used by the CDN API. Each is exported as an `as const` object (for autocompletion and
 * runtime use) and a string-literal union type. The union is widened with `(string & {})` so a value added
 * on the server later still type-checks and is passed through unchanged instead of breaking your build.
 */

/** Whether a bucket (and every file in it) is reachable anonymously through `/public/...`. */
export const BucketVisibility = {
  Private: "Private",
  Public: "Public",
} as const;
export type BucketVisibility = (typeof BucketVisibility)[keyof typeof BucketVisibility] | (string & {});

/** Coarse media-type grouping computed by the server from the content type at upload time. */
export const FileCategory = {
  Image: "Image",
  Video: "Video",
  Audio: "Audio",
  Document: "Document",
  Other: "Other",
} as const;
export type FileCategory = (typeof FileCategory)[keyof typeof FileCategory] | (string & {});

/** Lifecycle of a file's generated thumbnail. */
export const ThumbnailStatus = {
  NotApplicable: "NotApplicable",
  Pending: "Pending",
  Ready: "Ready",
  Failed: "Failed",
} as const;
export type ThumbnailStatus = (typeof ThumbnailStatus)[keyof typeof ThumbnailStatus] | (string & {});

/**
 * Columns a file listing can be sorted by. Values are the server's wire names (note `CreatedAtUTC`).
 */
export const FileSortBy = {
  CreatedAtUtc: "CreatedAtUTC",
  OriginalFileName: "OriginalFileName",
  SizeBytes: "SizeBytes",
  ContentType: "ContentType",
  Bucket: "Bucket",
} as const;
export type FileSortBy = (typeof FileSortBy)[keyof typeof FileSortBy] | (string & {});

/** Why one entry of a batch presign request failed. */
export const PresignFailureReason = {
  NotFound: "NotFound",
  Forbidden: "Forbidden",
} as const;
export type PresignFailureReason =
  (typeof PresignFailureReason)[keyof typeof PresignFailureReason] | (string & {});
