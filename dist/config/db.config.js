import { connect, set } from "mongoose";
import envConfig from "./env.config.js";
set("sanitizeFilter", true);
const dbConfig = async () => {
    try {
        const db = await connect(envConfig.MONGO_URI);
        console.log(`Database connected to HOST: ${db.connection.host}`);
    }
    catch (error) {
        console.error("Database connection failed:", error);
        process.exit(1);
    }
};
export default dbConfig;
//# sourceMappingURL=db.config.js.map