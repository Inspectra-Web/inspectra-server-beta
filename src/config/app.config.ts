import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import envConfig from "./env.config.js";
import globalErrorHandler, { notFound } from "../error/global.error.js";
import authRoute from "../routes/auth.route.js";
import profileRoute from "../routes/profile.route.js";

const appConfig = (app: Express): void => {
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: envConfig.CLIENT_URL, credentials: true }));

  app.use(express.json({ limit: "10kb" }));
  app.use(express.urlencoded({ extended: true, limit: "10kb" }));
  app.use(cookieParser());

  if (envConfig.NODE_ENV === "development") app.use(morgan("dev"));

  app.get("/", (_req, res) => {
    res.status(200).json({ status: "success", message: "Welcome to the INSPECTRA API" });
  });

  app.use("/api/v1/auth", authRoute);
  app.use("/api/v1/profile", profileRoute);

  app.use(notFound);
  app.use(globalErrorHandler);
};

export default appConfig;
