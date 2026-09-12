import { Schema, model, type Types } from "mongoose";

/**
 * One row per person who has opened a listing, which is what makes `Property.views`
 * mean something: the counter it backs is people, not page loads.
 *
 * A separate collection rather than an array of viewer ids on the property, because
 * that array has no upper bound and would be dragged into memory on every read of a
 * popular listing. Here the row is written once and never read back individually.
 */
export interface IPropertyView {
  property: Types.ObjectId;
  user: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const propertyViewSchema = new Schema<IPropertyView>(
  {
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
  },
  { timestamps: true },
);

// The whole point of the collection: one view per person per listing. The upsert in
// recordView reads the result to decide whether to count, and this is what holds when
// two tabs open the same listing at the same moment.
propertyViewSchema.index({ property: 1, user: 1 }, { unique: true });

const PropertyView = model<IPropertyView>("PropertyView", propertyViewSchema);

export default PropertyView;
