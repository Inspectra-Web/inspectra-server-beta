import { Readable } from "node:stream";
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

/** One buffer to Cloudinary. `auto` lets a PDF through as a raw file. */
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

// A title document is scanned or photographed, so both are allowed.
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOCUMENT_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") {
      cb(null, true);
      return;
    }

    cb(new AppError("Upload a PDF or an image of the document.", 400));
  },
});

// Fitted inside the box rather than cropped: a listing photo composed by the
// realtor should not lose its edges the way a square headshot can afford to.
export const uploadPhoto = async (buffer: Buffer): Promise<UploadedImage> => {
  const image = await sharp(buffer)
    .rotate()
    .resize(PHOTO_WIDTH, PHOTO_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  return send(image, PHOTO_FOLDER, "image");
};

// Sent as-is: a PDF has no pixels to resize, and re-encoding a scan loses detail
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
