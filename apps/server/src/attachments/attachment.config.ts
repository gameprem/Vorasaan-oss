export type AttachmentLimits = {
  /** Largest upload or fetched page, in bytes. Enforced while streaming. */
  maxBytes: number;
  /** Longest Snapshot, in characters; longer text is cut and marked as truncated. */
  maxSnapshotChars: number;
  /** Lets URL Attachments reach private/loopback addresses (e.g. an intranet wiki). */
  allowPrivateUrls: boolean;
};

const MiB = 1024 * 1024;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Read on every request, so an operator (or a test) can change them without a restart. */
export function attachmentLimits(env: Record<string, string | undefined> = process.env) {
  return {
    maxBytes: positiveInt(env.ATTACHMENT_MAX_BYTES, 20 * MiB),
    maxSnapshotChars: positiveInt(env.ATTACHMENT_SNAPSHOT_MAX_CHARS, 200_000),
    allowPrivateUrls: env.ATTACHMENT_ALLOW_PRIVATE_URLS === 'true',
  } satisfies AttachmentLimits;
}
