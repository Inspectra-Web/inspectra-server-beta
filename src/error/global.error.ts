import type { NextFunction, Request, Response } from "express";
import { Error as MongooseError } from "mongoose";
import { MulterError } from "multer";
import { ZodError } from "zod";
import envConfig from "../config/env.config.js";
import AppError from "./app.error.js";
import { AVATAR_MAX_MB } from "../services/upload.service.js";

const handleCastError = (error: any) =>
  new AppError(`Invalid ${error.path}: ${error.value}`, 400);

const handleDuplicateKeyError = (error: any) => {
  const field = Object.keys(error.keyValue)[0];
  const value = error.keyValue[field!];
  const capitalizeField = field![0]?.toUpperCase() + field!.slice(1);

  return new AppError(
    `${capitalizeField} ${value} already exists on our record.`,
    409,
  );
};

const handleValidationError = (error: MongooseError.ValidationError) => {
  const messages = Object.values(error.errors).map((err) => err.message);
  return new AppError(messages.join(". "), 422);
};

const handleMulterError = (error: MulterError) => {
  if (error.code === "LIMIT_FILE_SIZE")
    return new AppError(`Image must be ${AVATAR_MAX_MB}MB or smaller.`, 413);

  if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE")
    return new AppError("Send a single image in the avatar field.", 400);

  return new AppError(`Upload failed: ${error.message}`, 400);
};

const handleJwtError = () =>
  new AppError("Invalid token. Please log in again.", 401);

const handleJwtExpiredError = () =>
  new AppError("Your session has expired. Please log in again.", 401);

const handleZodError = (error: ZodError) => {
  // Name the field: "Invalid input: expected string" alone is unusable.
  const messages = error.issues.map((issue) =>
    issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  );

  return new AppError(messages.join(". "), 422);
};

/** Reached when no route matched. Hands a 404 to the handler below. */
export const notFound = (req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError(`Cannot ${req.method} ${req.originalUrl}`, 404));
};

const globalErrorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  let error: Error | AppError = err;

  if (!(error instanceof AppError)) {
    if (error.name === "CastError") error = handleCastError(error);
    if (error.name === "ValidationError")
      error = handleValidationError(error as MongooseError.ValidationError);
    if ((error as any).code === 11000) error = handleDuplicateKeyError(error);
    // Name checks, not instanceof: TokenExpiredError extends JsonWebTokenError.
    if (error.name === "JsonWebTokenError") error = handleJwtError();
    if (error.name === "TokenExpiredError") error = handleJwtExpiredError();
    if (error instanceof ZodError) error = handleZodError(error);
    if (error instanceof MulterError) error = handleMulterError(error);
  }

  if (envConfig.NODE_ENV === "development") {
    const statusCode = error instanceof AppError ? error.statusCode : 500;

    console.log(error);
    res.status(statusCode).json({
      status: error instanceof AppError ? error.status : "error",
      message: error.message,
      stack: error.stack,
      error,
    });
    return;
  }

  if (error instanceof AppError && error.isOperational) {
    res
      .status(error.statusCode)
      .json({ status: error.status, message: error.message });
    return;
  }

  console.error("UNEXPECTED_ERROR:", {
    message: error.message,
    stack: error.stack,
  });

  res.status(500).json({
    status: "error",
    message: "An unexpected error occurred. Please try again.",
  });
};

export default globalErrorHandler;
