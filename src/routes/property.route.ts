import { Router, type RequestHandler } from "express";

import {
  addPropertyDocument,
  addPropertyPhotos,
  createProperty,
  deleteMyProperty,
  getMyProperty,
  getProperty,
  getPropertyDocument,
  listMyProperties,
  listProperties,
  updateMyProperty,
} from "../controllers/property.controller.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { documentUpload, photoUpload } from "../services/upload.service.js";
import {
  addDocumentSchema,
  createPropertySchema,
  updatePropertySchema,
} from "../validators/property.validator.js";

const router = Router();

/**
 * "/me" is the realtor's own list, declared below the session gate. Express matches
 * in declaration order, so the public detail route above it has to let that path
 * through rather than treating "me" as a slug and 404ing on it. It is a valid slug
 * shape, so the guard cannot be left to the param regex.
 */
const notMe: RequestHandler = (req, _res, next) =>
  next(req.params.slug === "me" ? "route" : undefined);

// Public: the marketplace browse and one listing, no auth. Above the gate below.
// A listing is addressed by its slug here; the realtor and admin routes use the id.
router.get("/", listProperties);
router.get("/:slug", notMe, getProperty);

router.use(protect);

// The one route on this router an admin may reach: the review console has to read the
// documents it is judging, and the handler checks owner-or-admin itself. Declared before
// the realtor gate below so that gate does not shut an admin out of it.
router.get("/:id/documents/:docId/file", getPropertyDocument);

router.use(restrictTo("realtor"));

// Declared before "/:id", and kept off "/" so the public browse can take that later.
router.get("/me", listMyProperties);
router.get("/me/:id", getMyProperty);

router.post("/", validate(createPropertySchema), createProperty);

router.patch("/:id", validate(updatePropertySchema), updateMyProperty);
router.delete("/:id", deleteMyProperty);

// Files, which is why these are separate from the JSON body above.
router.post("/:id/photos", photoUpload.array("photos", 20), addPropertyPhotos);
router.post(
  "/:id/documents",
  documentUpload.single("document"),
  validate(addDocumentSchema),
  addPropertyDocument,
);

export default router;
