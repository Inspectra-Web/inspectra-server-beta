/**
 * The shared property vocabulary: what a thing *is* (type) and the bucket it
 * sells under (category). Types overlap categories on purpose, so a serviced
 * apartment can be listed as residential, commercial or mixed use.
 *
 * Lives here rather than on a model because the seeker's stated interests and,
 * later, the listings themselves have to agree on one list.
 *
 * Stored as slugs, not display text. The client renders its own labels, which
 * keeps wording changes ("Self contained" vs "Self-con") off the database.
 */
export const PROPERTY_TYPES_BY_CATEGORY = {
    residential: [
        "apartment",
        "flat",
        "self-contained",
        "studio",
        "duplex",
        "terrace",
        "townhouse",
        "maisonette",
        "bungalow",
        "detached",
        "semi-detached",
        "villa",
        "mansion",
        "penthouse",
        "condominium",
        "serviced-apartment",
        "single-family-home",
        "multi-family-home",
    ],
    commercial: [
        "office",
        "shop",
        "studio",
        "warehouse",
        "restaurant",
        "hotel",
        "resort",
        "serviced-apartment",
    ],
    industrial: ["factory", "warehouse", "farm"],
    land: ["land"],
    agricultural: ["farm", "land"],
    hospitality: ["hotel", "resort", "restaurant"],
    "mixed-use": ["office", "shop", "apartment", "warehouse", "studio", "land", "serviced-apartment"],
    institutional: ["hospital", "school"],
    recreational: ["resort", "hotel", "campground"],
    other: ["other"],
};
/**
 * Every type once, in category order, so the enum and the category map cannot
 * drift apart. Category order doubles as a sensible display order.
 */
export const PROPERTY_TYPES = [
    ...new Set(Object.values(PROPERTY_TYPES_BY_CATEGORY).flat()),
];
export const PROPERTY_CATEGORIES = Object.keys(PROPERTY_TYPES_BY_CATEGORY);
//# sourceMappingURL=property.type.js.map