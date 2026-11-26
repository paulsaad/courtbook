/**
 * Browser-side shrink before upload. A phone photo is often 3–8 MB, and Vercel refuses any request body over 4.5 MB
 * before our route runs, so the original cannot be sent as it is. The browser decodes the photo (applying its
 * orientation), scales it to at most 1024 px on its longer side and sends a JPEG of a few hundred KB.
 *
 * This is a transport step, not a safety step: the server still decodes and re-encodes whatever arrives
 * (processPhoto), so a browser that skips or fakes this changes nothing about what is stored.
 */
export const UPLOAD_MAX = 4 * 1024 * 1024;   // under Vercel's 4.5 MB request limit, with room for the form encoding
const MAX_SIDE = 1024;

export function scaledSize(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The file to send. If the browser cannot decode it (an unusual format), the original is sent and the server decides. */
export async function shrinkForUpload(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close(); return file; }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}
