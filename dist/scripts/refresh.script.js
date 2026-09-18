import { disconnect, trusted } from "mongoose";
import dbConfig from "../config/db.config.js";
import Property from "../models/property.model.js";
/**
 * Gives every listing written before subscriptions a refreshedAt and a hiddenByPlan.
 *
 * A schema default only fires on insert, so listings already in the database have
 * neither field. hiddenByPlan can be left alone in principle, since the public filter
 * tests `$ne: true` and missing passes it, but refreshedAt cannot: the newest sort now
 * keys on it, and Mongo sorts a missing field below every real date, so the entire
 * existing catalogue would fall to the bottom of the recency sort at once.
 *
 * refreshedAt starts at createdAt, which is what an unrefreshed listing means.
 *
 * `timestamps: false` on the write: a backfill is not an edit by the realtor and must
 * not make every listing look like it just changed.
 */
const backfillRefreshed = async () => {
    await dbConfig();
    const dated = await Property.updateMany({ refreshedAt: trusted({ $exists: false }) }, [{ $set: { refreshedAt: "$createdAt", hiddenByPlan: false } }], 
    // updatePipeline: Mongoose 9 will not take an aggregation pipeline without it, and
    // a pipeline is what lets refreshedAt copy each listing's own createdAt.
    { timestamps: false, updatePipeline: true });
    console.log(`Dated ${dated.modifiedCount} listing(s) from their creation time.`);
    await disconnect();
    process.exit(0);
};
backfillRefreshed().catch(async (error) => {
    console.error("Refresh backfill failed:", error);
    await disconnect();
    process.exit(1);
});
//# sourceMappingURL=refresh.script.js.map