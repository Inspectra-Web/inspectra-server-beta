import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import multer from "multer";
import sharp from "sharp";

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
 * The INSPECTRA mark burned into the centre of every listing photo.
 *
 * Centre, because a corner mark is cropped off in seconds: cropping this one out means
 * cropping out the property. Burned in at upload rather than applied as a Cloudinary
 * delivery transformation, because a transformation leaves a clean original on the CDN
 * reachable by editing the URL, which is exactly the person this exists to stop.
 *
 * One mark, deliberately: an earlier version also tiled the wordmark across the whole
 * frame, which resists watermark removers far better (they inpaint from the clean pixels
 * around a mark, and full coverage leaves none) but reads as heavy on a photograph whose
 * job is to sell a property. The trade was made knowingly in favour of the photograph.
 * A single mark is the easy case for a remover, so this deters a lazy reposter and
 * nothing more.
 */
const MARK_RATIO = 0.3;
const MARK_MIN = 120;
const MARK_OPACITY = 0.5;
const SHADOW_OPACITY = 0.35;
const SHADOW_OFFSET = 2;
// Keyed by width, and a handful of widths covers every upload.
const MARK_CACHE_MAX = 8;

// Resolved from this module rather than the working directory, so it survives both `tsx`
// on src/ and `node` on dist/: both sit two levels under the package root.
const MARK_FILE = fileURLToPath(new URL("../../assets/watermark.png", import.meta.url));

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

interface Mark {
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

/** The wordmark at a given width, with its own silhouette behind it for legibility. */
const buildMark = async (width: number): Promise<Mark> => {
  const logo = await sharp(MARK_FILE).resize({ width }).png().toBuffer();
  const { width: w = width, height: h = 0 } = await sharp(logo).metadata();

  // The mark is white, so `negate` on the colour channels alone gives its exact silhouette
  // in black. Sitting a couple of pixels behind, it holds up on a pale wall as well as a
  // dark interior.
  const shadow = await fade(
    await sharp(logo).negate({ alpha: false }).png().toBuffer(),
    SHADOW_OPACITY * MARK_OPACITY,
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
      { input: await fade(logo, MARK_OPACITY), top: 0, left: 0 },
    ])
    .png()
    .toBuffer();

  return { data, width: w + SHADOW_OFFSET, height: h + SHADOW_OFFSET };
};

const marks = new Map<number, Mark>();

const markFor = async (width: number): Promise<Mark> => {
  const cached = marks.get(width);
  if (cached) return cached;

  const mark = await buildMark(width);

  if (marks.size >= MARK_CACHE_MAX) marks.clear();
  marks.set(width, mark);

  return mark;
};

// Fitted inside the box rather than cropped: a listing photo composed by the
// realtor should not lose its edges the way a square headshot can afford to.
export const uploadPhoto = async (buffer: Buffer): Promise<UploadedImage> => {
  // Resized first, so the mark is sized against what the photo actually became:
  // `withoutEnlargement` means a small upload keeps its own dimensions.
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(PHOTO_WIDTH, PHOTO_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  const mark = await markFor(
    Math.min(info.width, Math.max(MARK_MIN, Math.round(info.width * MARK_RATIO))),
  );

  const image = await sharp(data)
    .composite([
      {
        input: mark.data,
        top: Math.max(0, Math.round((info.height - mark.height) / 2)),
        left: Math.max(0, Math.round((info.width - mark.width) / 2)),
      },
    ])
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
