import { IMAGE_MAX_SIDE } from "@sling/core";

const QUALITY = 0.85;

/** Whether any pixel is see-through. */
function hasAlpha(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  w: number,
  h: number,
) {
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

function canvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

async function encode(c: OffscreenCanvas | HTMLCanvasElement, type: string): Promise<Blob | null> {
  if ("convertToBlob" in c) return c.convertToBlob({ type, quality: QUALITY });
  return new Promise((ok) => c.toBlob(ok, type, QUALITY));
}

/**
 * An image as it's sent: at most IMAGE_MAX_SIDE on its long side, as JPEG
 * at 0.85 unless it's a PNG with transparency. A GIF, which may move, and
 * an image the browser can't open, go as they are.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  // Already small enough as a JPEG: re-encoding would only lose detail.
  if (scale === 1 && file.type === "image/jpeg") {
    bitmap.close();
    return file;
  }
  const c = canvas(w, h);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const png = file.type === "image/png" && hasAlpha(ctx, w, h);
  if (png && scale === 1) return file;
  const blob = await encode(c, png ? "image/png" : "image/jpeg");
  if (!blob) return file;
  const base = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], png ? `${base}.png` : `${base}.jpg`, { type: blob.type });
}
