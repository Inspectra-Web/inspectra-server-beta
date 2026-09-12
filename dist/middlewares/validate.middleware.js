/**
 * Parses and replaces req.body. Synchronous, so a ZodError reaches the global
 * handler through Express's own error path.
 */
const validate = (schema) => (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
};
export default validate;
//# sourceMappingURL=validate.middleware.js.map