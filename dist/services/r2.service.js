import { randomBytes } from "node:crypto";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client, UploadPartCommand, } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
/**
 * Cloudflare R2 holds the course's lesson videos, privately. Two things make a video
 * unusable outside INSPECTRA: the bucket is never public, and every link to a file is
 * signed and expires within the hour, handed only to a paid realtor (or an admin).
 *
 * Uploads go from the admin's browser straight to R2 in parts (multipart), so a 1 GB
 * file never passes through this server; the server only signs each part's address and
 * then has R2 join them.
 */
/** Each part of an upload. R2 wants every part but the last the same size, at least 5 MiB. */
export const PART_SIZE = 50 * 1024 * 1024;
/** The largest lesson video accepted. */
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024;
/** How long a signed part address works: long enough for one part on a slow connection. */
const PART_URL_SECONDS = 60 * 60;
/** How long a realtor's link to a video works. */
export const PLAYBACK_URL_SECONDS = 60 * 60;
let client = null;
export const r2Configured = () => !!(envConfig.R2_ACCOUNT_ID && envConfig.R2_ACCESS_KEY_ID && envConfig.R2_SECRET_ACCESS_KEY && envConfig.R2_BUCKET);
const r2 = () => {
    if (!r2Configured())
        throw new AppError("Video storage is not set up yet. Add the R2 settings to the server.", 503);
    client ??= new S3Client({
        region: "auto",
        endpoint: `https://${envConfig.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: envConfig.R2_ACCESS_KEY_ID,
            secretAccessKey: envConfig.R2_SECRET_ACCESS_KEY,
        },
    });
    return { s3: client, bucket: envConfig.R2_BUCKET };
};
const failed = (action, error) => {
    console.error(`R2_${action}_FAILED:`, error);
    return new AppError("We could not reach the video storage. Try again.", 502);
};
/** Where a lesson's video lives in the bucket. Random, so a replaced file never collides. */
export const videoKeyFor = (lessonId, fileName) => {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(fileName)?.[1]?.toLowerCase() ?? "mp4";
    return `course/lessons/${lessonId}/${randomBytes(8).toString("hex")}.${ext}`;
};
export const startUpload = async (key, contentType) => {
    const { s3, bucket } = r2();
    try {
        const out = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
        if (!out.UploadId)
            throw new Error("No upload id");
        return out.UploadId;
    }
    catch (error) {
        throw failed("START", error);
    }
};
/** Signed addresses the browser PUTs each part to. */
export const partUrls = async (key, uploadId, partNumbers) => {
    const { s3, bucket } = r2();
    return Promise.all(partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(s3, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: PART_URL_SECONDS }),
    })));
};
/** Has R2 join the parts into one file, and answers with its size in bytes. */
export const completeUpload = async (key, uploadId, parts) => {
    const { s3, bucket } = r2();
    try {
        await s3.send(new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: [...parts]
                    .sort((a, b) => a.partNumber - b.partNumber)
                    .map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })),
            },
        }));
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return head.ContentLength ?? 0;
    }
    catch (error) {
        console.error("R2_COMPLETE_FAILED:", error);
        throw new AppError("The upload could not be finished. Upload the video again.", 400);
    }
};
/** Never throws: an upload that cannot be cancelled is cleared by R2 on its own after a week. */
export const abortUpload = async (key, uploadId) => {
    if (!key || !uploadId || !r2Configured())
        return;
    const { s3, bucket } = r2();
    try {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    }
    catch (error) {
        console.error("R2_ABORT_FAILED:", key, error);
    }
};
/** Never throws: a file that cannot be deleted is logged, not allowed to fail a save. */
export const deleteVideoFile = async (key) => {
    if (!key || !r2Configured())
        return;
    const { s3, bucket } = r2();
    try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
    catch (error) {
        console.error("R2_DELETE_FAILED:", key, error);
    }
};
/** A link to play one video, valid for an hour. */
export const playbackUrl = (key) => {
    const { s3, bucket } = r2();
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: PLAYBACK_URL_SECONDS,
    });
};
//# sourceMappingURL=r2.service.js.map