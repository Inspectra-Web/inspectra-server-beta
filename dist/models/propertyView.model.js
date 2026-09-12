import { Schema, model } from "mongoose";
const propertyViewSchema = new Schema({
    property: {
        type: Schema.Types.ObjectId,
        ref: "Property",
        required: [true, "A view must belong to a listing"],
    },
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: [true, "A view must belong to a user"],
    },
}, { timestamps: true });
// The whole point of the collection: one view per person per listing. The upsert in
// recordView reads the result to decide whether to count, and this is what holds when
// two tabs open the same listing at the same moment.
propertyViewSchema.index({ property: 1, user: 1 }, { unique: true });
const PropertyView = model("PropertyView", propertyViewSchema);
export default PropertyView;
//# sourceMappingURL=propertyView.model.js.map