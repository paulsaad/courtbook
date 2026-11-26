import "server-only";
import sharp from "sharp";
import { PHOTO } from "./shared";

export type Processed =
  | { ok: true; webp: Buffer; width: number; height: number }
  | { ok: false; reason: "not_image" | "too_large" };

/**
 * Decode whatever was uploaded and re-encode it as a small square WebP. Decoding proves it is an image whatever its
 * name or declared type; re-encoding carries no metadata across, so EXIF — including a phone's GPS position — is gone;
 * the EXIF orientation is applied first so the photo is not stored sideways. Quality steps down until it fits.
 */
export async function processPhoto(input: Buffer): Promise<Processed> {
  if (input.byteLength > PHOTO.maxInput) return { ok: false, reason: "too_large" };
  try {
    for (const quality of [80, 65, 50]) {
      const webp = await sharp(input, { failOn: "error", limitInputPixels: 50_000_000 })
        .rotate()
        .resize(PHOTO.size, PHOTO.size, { fit: "cover", position: "centre" })
        .webp({ quality })
        .toBuffer();
      if (webp.byteLength <= PHOTO.maxOutput) {
        const meta = await sharp(webp).metadata();
        return { ok: true, webp, width: meta.width ?? PHOTO.size, height: meta.height ?? PHOTO.size };
      }
    }
    return { ok: false, reason: "too_large" };
  } catch {
    return { ok: false, reason: "not_image" };
  }
}
