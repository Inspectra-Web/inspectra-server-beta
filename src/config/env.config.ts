import { config } from "dotenv";

config();

const envConfig = {
  PORT: process.env.PORT!,
  MONGO_URI: process.env.MONGO_URI!,
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET!,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN!,
  JWT_COOKIE_EXPIRES_DAYS: process.env.JWT_COOKIE_EXPIRES_DAYS!,
  CLIENT_URL: process.env.CLIENT_URL!,
  RESEND_API_KEY: process.env.RESEND_API_KEY!,
  RESEND_EMAIL: process.env.RESEND_EMAIL!,
  RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY!,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET!,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME!,
  DOJAH_BASE_URL: process.env.DOJAH_BASE_URL!,
  DOJAH_APP_ID: process.env.DOJAH_APP_ID!,
  DOJAH_SECRET_KEY: process.env.DOJAH_SECRET_KEY!,
  // Read only by src/scripts/admin.script.ts, which checks them itself.
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ADMIN_FULLNAME: process.env.ADMIN_FULLNAME,
};

export default envConfig;
