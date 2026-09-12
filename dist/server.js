import express from "express";
import appConfig from "./config/app.config.js";
import dbConfig from "./config/db.config.js";
import envConfig from "./config/env.config.js";
const app = express();
const port = Number(envConfig.PORT);
appConfig(app);
await dbConfig();
const server = app.listen(port, () => {
    console.log(`Server is listening to PORT: ${port}`);
});
const shutdown = (signal) => {
    console.log(`${signal} received. Shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
    console.error("uncaughtException:", error.name, error.message);
    process.exit(1);
});
process.on("unhandledRejection", (error) => {
    if (error instanceof Error)
        console.error("unhandledRejection:", error.name, error.message);
    server.close(() => process.exit(1));
});
//# sourceMappingURL=server.js.map