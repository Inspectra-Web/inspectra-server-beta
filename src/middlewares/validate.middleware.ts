import type { RequestHandler } from "express";
import type { ZodType } from "zod";

/**
 * Parses and replaces req.body. Synchronous, so a ZodError reaches the global
 * handler through Express's own error path.
 */
const validate =
  (schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };

export default validate;
