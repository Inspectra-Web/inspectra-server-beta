import { disconnect, trusted } from "mongoose";

import dbConfig from "../config/db.config.js";
import Property, { buildSlug } from "../models/property.model.js";

/**
 * Stamps a slug onto listings created before the field existed. The hook only fires
 * on save, so rows already in the collection would otherwise sit without one, and a
 * unique index cannot be built over several documents that all lack the key.
 *
 * `timestamps: false` on the write: this is a backfill, not an edit by the realtor,
 * and it must not look like the listing changed.
 */
const backfillSlugs = async (): Promise<void> => {
  await dbConfig();

  // trusted(): db.config sets sanitizeFilter globally, which would otherwise turn
  // the operator into an equality match on the literal object.
  const properties = await Property.find({
    $or: [{ slug: trusted({ $exists: false }) }, { slug: "" }],
  }).select("_id title slug");

  if (properties.length === 0) {
    console.log("Every listing already carries a slug.");
    await disconnect();
    process.exit(0);
  }

  for (const property of properties) {
    const slug = buildSlug(property.title, String(property._id));

    await Property.updateOne({ _id: property._id }, { $set: { slug } }, { timestamps: false });

    console.log(`${String(property._id)} -> ${slug}`);
  }

  console.log(`Stamped ${properties.length} listing(s).`);

  await disconnect();
  process.exit(0);
};

backfillSlugs().catch(async (error: unknown) => {
  console.error("Slug backfill failed:", error);
  await disconnect();
  process.exit(1);
});
