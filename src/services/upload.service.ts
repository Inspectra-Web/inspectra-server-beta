import { Readable } from "node:stream";
import multer from "multer";
import sharp from "sharp";

import cloudinary from "../config/cloudinary.config.js";
import AppError from "../error/app.error.js";

export const AVATAR_MAX_MB = 2;

const AVATAR_FOLDER = "inspectra/avatars";
const AVATAR_SIZE = 512;

export interface UploadedImage {
  url: string;
  publicId: string;
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

// Square and top-anchored: a headshot loses the chin before it loses the face.
export const uploadAvatar = async (buffer: Buffer): Promise<UploadedImage> => {
  const image = await sharp(buffer)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "top" })
    .jpeg({ quality: 82 })
    .toBuffer();

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: AVATAR_FOLDER, resource_type: "image" },
      (error, result) => {
        if (error || !result) {
          reject(new AppError("Could not upload the image. Please try again.", 502));
          return;
        }

        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );

    Readable.from(image).pipe(stream);
  });
};

// Never throws: a stale id must not block the update that replaces the image.
export const destroyAvatar = async (publicId: string): Promise<void> => {
  if (!publicId) return;

  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error("CLOUDINARY_DESTROY_FAILED:", publicId, error);
  }
};
