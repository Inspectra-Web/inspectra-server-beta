import type { HydratedDocument } from "mongoose";
import type { IUser, IUserMethods } from "../models/user.model.js";

/** Set by `protect`. Ambient, so no route registration needs a cast. */
declare global {
  namespace Express {
    interface Request {
      user?: HydratedDocument<IUser, IUserMethods>;
    }
  }
}

export {};
