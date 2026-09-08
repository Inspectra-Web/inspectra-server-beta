import { Router } from "express";

import {
  addPropertyDocument,
  addPropertyPhotos,
  createProperty,
  deleteMyProperty,
  getMyProperty,
  listMyProperties,
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

router.use(protect, restrictTo("realtor"));

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
