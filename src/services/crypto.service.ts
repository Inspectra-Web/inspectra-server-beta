import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import envConfig from "../config/env.config.js";

const ALGORITHM = "aes-256-gcm";

const key = (): Buffer => {
  const value = Buffer.from(envConfig.IDENTITY_ENCRYPTION_KEY ?? "", "base64");

  if (value.length !== 32) throw new Error("IDENTITY_ENCRYPTION_KEY must be 32 bytes, base64");

  return value;
};

/** `iv.tag.ciphertext`, each base64. A fresh IV every call, so equal inputs never match. */
export const encrypt = (text: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);

  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
};

export const decrypt = (payload: string): string => {
  const [iv, tag, body] = payload.split(".").map((part) => Buffer.from(part, "base64"));

  if (!iv || !tag || !body) throw new Error("Malformed ciphertext");

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
};

/** Deterministic, so a unique index can spot the same number on two accounts. */
export const fingerprint = (text: string): string =>
  createHmac("sha256", key()).update(text).digest("hex");
