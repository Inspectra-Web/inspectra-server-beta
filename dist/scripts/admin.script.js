import { disconnect } from "mongoose";
import dbConfig from "../config/db.config.js";
import envConfig from "../config/env.config.js";
import User from "../models/user.model.js";
import { ensureProfile } from "../services/profile.service.js";
const seedAdmin = async () => {
    const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULLNAME } = envConfig;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_FULLNAME) {
        console.error("Set ADMIN_EMAIL, ADMIN_PASSWORD and ADMIN_FULLNAME in .env before seeding.");
        process.exit(1);
    }
    await dbConfig();
    const email = ADMIN_EMAIL.trim().toLowerCase();
    const existing = await User.findOne({ email });
    const user = existing ?? new User({ email, fullname: ADMIN_FULLNAME });
    user.fullname = ADMIN_FULLNAME;
    user.password = ADMIN_PASSWORD;
    user.role = "admin";
    user.status = "active";
    user.emailVerified = true;
    await user.save();
    await ensureProfile(user);
    console.log(existing
        ? `Promoted ${user.email} to admin and reset the password.`
        : `Created admin ${user.email}.`);
    await disconnect();
    process.exit(0);
};
seedAdmin().catch(async (error) => {
    console.error("Admin seed failed:", error);
    await disconnect();
    process.exit(1);
});
//# sourceMappingURL=admin.script.js.map