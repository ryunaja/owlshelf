/**
 * capture.ts — compress at capture (plan §8.1).
 *
 * The dialog's "PNG, JPG up to 4 MB" copy is the RAW-input cap. The 1 MB
 * rule is POST-compression: accept ≤4 MB, downscale to ≤1024px on the long
 * edge, encode WebP q0.8 (~50× smaller), then hard-fail if the result is
 * still over 1 MB. Failing loudly beats storing a blob that will not fit a
 * transfer budget later (§6.6 bounds transfers by total bytes, not just
 * chunk size).
 *
 * Nothing here touches the database: the caller writes the returned bytes to
 * `files` and stores `idb://<hash>` on the row. That keeps the tab's job
 * ("image capture") separate from the command path's ("mint the op").
 */

import { sha256Hex } from "./hash";

export const MAX_RAW_BYTES = 4 * 1024 * 1024;
export const MAX_COMPRESSED_BYTES = 1024 * 1024;
export const MAX_DIMENSION = 1024;
export const WEBP_QUALITY = 0.8;

export type CaptureErrorCode = "too-large" | "unsupported" | "decode";

export class CaptureError extends Error {
  code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
  }
}

export interface CapturedImage {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  hash: string;
}

/** Long edge ≤ MAX_DIMENSION, aspect preserved, never upscaled. */
export function fitWithin(
  width: number,
  height: number,
  max: number = MAX_DIMENSION,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to the <img> path */
    }
  }

  if (typeof Image === "undefined") {
    throw new CaptureError("unsupported", "no image decoder in this context");
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new CaptureError("decode", "the image could not be decoded"));
      img.src = url;
    });
  } finally {
    // The element keeps its own reference to the decoded bitmap.
    URL.revokeObjectURL(url);
  }
}

function dimensions(source: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width, height: source.height };
}

async function encode(
  source: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new CaptureError("unsupported", "no 2d context");
    ctx.drawImage(source, 0, 0, width, height);
    return canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  }

  if (typeof document === "undefined") {
    throw new CaptureError("unsupported", "no canvas in this context");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new CaptureError("unsupported", "no 2d context");
  ctx.drawImage(source, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", WEBP_QUALITY);
  });
  if (!blob) throw new CaptureError("unsupported", "the browser refused to encode WebP");
  return blob;
}

/**
 * Compress one captured image. Throws `CaptureError` — the dialog shows the
 * message and keeps the user's input, never closes on failure.
 */
export async function captureImage(file: Blob): Promise<CapturedImage> {
  if (file.size > MAX_RAW_BYTES) {
    throw new CaptureError(
      "too-large",
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 4 MB.`,
    );
  }

  const source = await decode(file);
  const { width, height } = dimensions(source);
  if (width === 0 || height === 0) {
    throw new CaptureError("decode", "the image has no pixels");
  }

  const target = fitWithin(width, height);
  const blob = await encode(source, target.width, target.height);
  if (source instanceof ImageBitmap) source.close();

  if (blob.size > MAX_COMPRESSED_BYTES) {
    throw new CaptureError(
      "too-large",
      `That image is still ${(blob.size / 1024).toFixed(0)} KB after compression — the limit is 1 MB.`,
    );
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    bytes,
    contentType: blob.type || "image/webp",
    hash: await sha256Hex(bytes),
  };
}
