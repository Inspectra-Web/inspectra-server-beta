import { disconnect } from "mongoose";
import dbConfig from "../config/db.config.js";
import Property from "../models/property.model.js";
import PropertyView from "../models/propertyView.model.js";
/**
 * Clears every view count and the rows behind it.
 *
 * `views` used to be incremented on every request to the public listing route, so the
 * numbers already stored are page loads: refreshes, link previews, dev server reloads
 * and realtors checking their own listings, all mixed together. They cannot be
 * converted into the new figure, because nothing recorded who did the looking. The
 * only honest thing to do with them is throw them away and start counting properly.
 *
 * `timestamps: false` on the write: a reset is not an edit by the realtor and must
 * not make every listing look like it just changed.
 */
const resetViews = async () => {
    await dbConfig();
    const rows = await PropertyView.deleteMany({});
    const listings = await Property.updateMany({}, { $set: { views: 0 } }, { timestamps: false });
    console.log(`Cleared ${rows.deletedCount} view row(s).`);
    console.log(`Reset ${listings.modifiedCount} listing(s) to zero views.`);
    await disconnect();
    process.exit(0);
};
resetViews().catch(async (error) => {
    console.error("View reset failed:", error);
    await disconnect();
    process.exit(1);
});
//# sourceMappingURL=views.script.js.map