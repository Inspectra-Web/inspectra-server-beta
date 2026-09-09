import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import multer from "multer";
import sharp, { type OverlayOptions } from "sharp";

import cloudinary from "../config/cloudinary.config.js";
import AppError from "../error/app.error.js";

export const AVATAR_MAX_MB = 2;
export const PHOTO_MAX_MB = 5;
export const DOCUMENT_MAX_MB = 10;

const AVATAR_FOLDER = "inspectra/avatars";
const PHOTO_FOLDER = "inspectra/properties";
const DOCUMENT_FOLDER = "inspectra/documents";
const AVATAR_SIZE = 512;
const PHOTO_WIDTH = 1600;
const PHOTO_HEIGHT = 1200;

export interface UploadedImage {
  url: string;
  publicId: string;
}

export interface UploadedFile extends UploadedImage {
  bytes: number;
}

export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }

    cb(new AppError("Upload an image file (JPG, PNG or WebP).", 400));
  },
});

/** One buffer to Cloudinary. Cloudinary files a PDF under `image`, like the photos. */
const send = (
  buffer: Buffer,
  folder: string,
  resourceType: "image" | "auto",
): Promise<UploadedFile> =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (error, result) => {
        if (error || !result) {
          reject(new AppError("Could not upload the file. Please try again.", 502));
          return;
        }

        resolve({ url: result.secure_url, publicId: result.public_id, bytes: result.bytes });
      },
    );

    Readable.from(buffer).pipe(stream);
  });

// Square and top-anchored: a headshot loses the chin before it loses the face.
export const uploadAvatar = async (buffer: Buffer): Promise<UploadedImage> => {
  const image = await sharp(buffer)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "top" })
    .jpeg({ quality: 82 })
    .toBuffer();

  return send(image, AVATAR_FOLDER, "image");
};

export const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }

    cb(new AppError("Upload image files (JPG, PNG or WebP).", 400));
  },
});

// PDF only. A scan has to be saved as one, which is what lets a single viewer serve every
// document and keeps the file out of an <img> a browser would offer to save.
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOCUMENT_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
      return;
    }

    cb(new AppError("Upload the document as a PDF.", 400));
  },
});

/** The mimetype is whatever the client claimed. These five bytes are not. */
export const isPdf = (buffer: Buffer): boolean =>
  buffer.subarray(0, 5).toString("latin1") === "%PDF-";

/**
 * The INSPECTRA mark burned into every listing photo.
 *
 * Two layers, and the reasons for each are different:
 *
 * - A **centre mark**, because a corner one is cropped off in seconds. Cropping this one
 *   out means cropping out the property.
 * - A **faint diagonal tile** across the whole frame, because watermark removers work by
 *   inpainting: they reconstruct the masked area from the clean pixels around it. A single
 *   mark, centred or not, is the easy case for that. Full coverage leaves nothing clean to
 *   sample from, so removal degrades the photo rather than rescuing it.
 *
 * Burned in at upload, not applied as a Cloudinary delivery transformation, because a
 * transformation leaves a clean original on the CDN reachable by editing the URL, which is
 * exactly the person this exists to stop. There is no unmarked copy.
 *
 * None of this is proof against a determined attacker with current inpainting tools. It
 * raises the cost above what a lazy reposter will pay, and it makes a stolen photo carry
 * the brand. The measure that survives removal is duplicate detection, not the mark.
 */
const CENTRE_RATIO = 0.3;
const CENTRE_OPACITY = 0.5;
const TILE_RATIO = 0.16;
const TILE_OPACITY = 0.1;
const TILE_ANGLE = -30;
const TILE_GAP_X = 1.3;
const TILE_GAP_Y = 1.5;
const SHADOW_OPACITY = 0.35;
const SHADOW_OFFSET = 2;
// Distinct output sizes are few, but the cache holds full-frame overlays, so cap it.
const OVERLAY_CACHE_MAX = 8;

// Resolved from this module rather than the working directory, so it survives both `tsx`
// on src/ and `node` on dist/: both sit two levels under the package root.
const MARK_FILE = fileURLToPath(new URL("../../assets/watermark.png", import.meta.url));

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

interface Layer {
  data: Buffer;
  width: number;
  height: number;
}

/** Multiplies an image's alpha, which is how sharp expresses opacity. */
const fade = (image: Buffer, alpha: number): Promise<Buffer> =>
  sharp(image)
    .composite([
      {
        input: Buffer.from([255, 255, 255, Math.round(255 * alpha)]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();

const sized = async (image: Buffer): Promise<Layer> => {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  return { data: image, width, height };
};

/** The wordmark at a given width, with its own silhouette behind it for legibility. */
const brandMark = async (width: number, opacity: number): Promise<Layer> => {
  const logo = await sharp(MARK_FILE).resize({ width }).png().toBuffer();
  const { width: w = width, height: h = 0 } = await sharp(logo).metadata();

  // The mark is white, so `negate` on the colour channels alone gives its exact silhouette
  // in black. Sitting a couple of pixels behind, it holds up on a pale wall as well as a
  // dark interior.
  const shadow = await fade(
    await sharp(logo).negate({ alpha: false }).png().toBuffer(),
    SHADOW_OPACITY * opacity,
  );

  const data = await sharp({
    create: {
      width: w + SHADOW_OFFSET,
      height: h + SHADOW_OFFSET,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite([
      { input: shadow, top: SHADOW_OFFSET, left: SHADOW_OFFSET },
      { input: await fade(logo, opacity), top: 0, left: 0 },
    ])
    .png()
    .toBuffer();

  return { data, width: w + SHADOW_OFFSET, height: h + SHADOW_OFFSET };
};

/**
 * One full-frame overlay: the diagonal tile, then the centre mark on top. Built on an
 * oversized canvas and cropped back, because sharp will not place a composite at a
 * negative offset, and the tile has to run off every edge to look continuous.
 */
const buildOverlay = async (width: number, height: number): Promise<Buffer> => {
  const tile = await sized(
    await sharp((await brandMark(Math.round(width * TILE_RATIO), TILE_OPACITY)).data)
      .rotate(TILE_ANGLE, { background: TRANSPARENT })
      .png()
      .toBuffer(),
  );

  const stepX = Math.max(1, Math.round(tile.width * TILE_GAP_X));
  const stepY = Math.max(1, Math.round(tile.height * TILE_GAP_Y));
  const padded = { width: width + tile.width * 2, height: height + tile.height * 2 };

  const tiles: OverlayOptions[] = [];

  for (let y = 0, row = 0; y < padded.height; y += stepY, row++) {
    // Every other row is nudged half a step, so the pattern reads as a weave rather than
    // a grid with obvious clean columns between the marks.
    const offset = row % 2 === 0 ? 0 : Math.round(stepX / 2);

    for (let x = 0; x + tile.width <= padded.width; x += stepX) {
      const left = x + offset;
      if (left + tile.width > padded.width) continue;
      tiles.push({ input: tile.data, top: y, left });
    }
  }

  const tiled = await sharp({
    create: { ...padded, channels: 4, background: TRANSPARENT },
  })
    .composite(tiles)
    .extract({ left: tile.width, top: tile.height, width, height })
    .png()
    .toBuffer();

  const centre = await brandMark(Math.round(width * CENTRE_RATIO), CENTRE_OPACITY);

  return sharp(tiled)
    .composite([
      {
        input: centre.data,
        top: Math.max(0, Math.round((height - centre.height) / 2)),
        left: Math.max(0, Math.round((width - centre.width) / 2)),
      },
    ])
    .png()
    .toBuffer();
};

// Built once per output size. A handful of sizes covers every upload, and building the
// tile per photo would mean dozens of composites each time.
const overlays = new Map<string, Buffer>();

const overlayFor = async (width: number, height: number): Promise<Buffer> => {
  const key = `${width}x${height}`;
  const cached = overlays.get(key);
  if (cached) return cached;

  const overlay = await buildOverlay(width, height);

  if (overlays.size >= OVERLAY_CACHE_MAX) overlays.clear();
  overlays.set(key, overlay);

  return overlay;
};

// Fitted inside the box rather than cropped: a listing photo composed by the
// realtor should not lose its edges the way a square headshot can afford to.
export const uploadPhoto = async (buffer: Buffer): Promise<UploadedImage> => {
  // Resized first, so the overlay is built against what the photo actually became:
  // `withoutEnlargement` means a small upload keeps its own dimensions.
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(PHOTO_WIDTH, PHOTO_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  const overlay = await overlayFor(info.width, info.height);

  const image = await sharp(data)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 82 })
    .toBuffer();

  return send(image, PHOTO_FOLDER, "image");
};
// Sent as-is: a PDF has no pixels to resize, and re-encoding a scan would lose detail
// the reviewer needs to read a survey plan.
export const uploadDocument = async (buffer: Buffer): Promise<UploadedFile> =>
  send(buffer, DOCUMENT_FOLDER, "auto");

// Never throws: a stale id must not block the update that replaces the image.
export const destroyAsset = async (
  publicId: string,
  resourceType: "image" | "raw" = "image",
): Promise<void> => {
  if (!publicId) return;

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (error) {
    console.error("CLOUDINARY_DESTROY_FAILED:", publicId, error);
  }
};

export const destroyAvatar = (publicId: string): Promise<void> => destroyAsset(publicId);
