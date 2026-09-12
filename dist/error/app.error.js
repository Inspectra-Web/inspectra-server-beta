class AppError extends Error {
    statusCode;
    status;
    isOperational = true;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.status = statusCode >= 400 && statusCode < 500 ? "fail" : "error";
        Object.setPrototypeOf(this, new.target.prototype);
        Error.captureStackTrace(this);
    }
}
export default AppError;
//# sourceMappingURL=app.error.js.map