import { config } from "dotenv";
config();
const envConfig = {
    PORT: process.env.PORT,
    MONGO_URI: process.env.MONGO_URI,
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN,
    JWT_COOKIE_EXPIRES_DAYS: process.env.JWT_COOKIE_EXPIRES_DAYS,
    CLIENT_URL: process.env.CLIENT_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_EMAIL: process.env.RESEND_EMAIL,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || "support@inspectraweb.com",
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    DOJAH_BASE_URL: process.env.DOJAH_BASE_URL,
    DOJAH_APP_ID: process.env.DOJAH_APP_ID,
    DOJAH_SECRET_KEY: process.env.DOJAH_SECRET_KEY,
    IDENTITY_ENCRYPTION_KEY: process.env.IDENTITY_ENCRYPTION_KEY,
    FLW_BASE_URL: process.env.FLW_BASE_URL,
    FLW_SECRET_KEY: process.env.FLW_SECRET_KEY,
    FLW_WEBHOOK_HASH: process.env.FLW_WEBHOOK_HASH,
    // The course incentive's first hop: Flutterwave pays ₦10,000 into this Planbok virtual
    // account, which then forwards it to LambaCard's account below.
    PLANBOK_BANK_CODE: process.env.PLANBOK_BANK_CODE,
    PLANBOK_ACCOUNT_NUMBER: process.env.PLANBOK_ACCOUNT_NUMBER,
    PLANBOK_ACCOUNT_NAME: process.env.PLANBOK_ACCOUNT_NAME,
    PLANBOK_ACCOUNT_ID: process.env.PLANBOK_ACCOUNT_ID,
    LAMBACARD_BANK_CODE: process.env.LAMBACARD_BANK_CODE,
    // LambaCard's purchase API. The key's prefix picks the environment (lbt_test_ is sandbox).
    LAMBACARD_BASE_URL: process.env.LAMBACARD_BASE_URL || "https://purchase-api.lambatoken.com/api/v1",
    LAMBACARD_API_KEY: process.env.LAMBACARD_API_KEY || "",
    LAMBACARD_WEBHOOK_SECRET: process.env.LAMBACARD_WEBHOOK_SECRET || "",
    // Sandbox only: settle test purchases on BSC Testnet rather than simulating them.
    LAMBACARD_EXECUTE_ON_CHAIN: process.env.LAMBACARD_EXECUTE_ON_CHAIN === "true",
    LAMBACARD_ACCOUNT_NUMBER: process.env.LAMBACARD_ACCOUNT_NUMBER,
    LAMBACARD_ACCOUNT_NAME: process.env.LAMBACARD_ACCOUNT_NAME,
    PLANBOK_BASE_URL: process.env.PLANBOK_BASE_URL || "https://api.planbok.io",
    PLANBOK_API_KEY: process.env.PLANBOK_API_KEY,
    PLANBOK_API_KEY_SPECIAL: process.env.PLANBOK_API_KEY_SPECIAL,
    // The raw 64-hex organization secret, not a ciphertext. In .env for now; it belongs
    // in a secrets manager before launch.
    PLANBOK_ORG_SECRET: process.env.PLANBOK_ORG_SECRET,
    PLANBOK_WALLET_SET_ID: process.env.PLANBOK_WALLET_SET_ID,
    // Cloudflare R2 holds the course's lesson videos. Optional: without them lessons keep
    // their existing videos and the upload endpoints say hosting is not set up.
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: process.env.R2_BUCKET,
    // Read only by src/scripts/admin.script.ts, which checks them itself.
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_FULLNAME: process.env.ADMIN_FULLNAME,
};
export default envConfig;
//# sourceMappingURL=env.config.js.map