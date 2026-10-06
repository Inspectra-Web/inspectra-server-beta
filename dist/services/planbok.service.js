import { constants, publicEncrypt } from "node:crypto";
import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
const UNREACHABLE = "We could not reach the payments service. Try again.";
const planbok = async (path, method = "GET", body) => {
    const response = await fetch(`${envConfig.PLANBOK_BASE_URL}/v2${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            "PLANBOK-X-API-KEY": envConfig.PLANBOK_API_KEY,
        },
        body: body && JSON.stringify(body),
    }).catch(() => {
        throw new AppError(UNREACHABLE, 502);
    });
    const result = await response.json().catch(() => ({}));
    if (!result.success) {
        console.error(`Planbok ${method} ${path} failed:`, result.errors?.message);
        throw new AppError(UNREACHABLE, 502);
    }
    return result.data;
};
let publicKey = "";
// A fresh ciphertext per call: Planbok rejects one older than 5 minutes.
const encryptedSecret = async () => {
    if (!publicKey)
        publicKey = (await planbok("/config/organization/public-key")).publicKey;
    const payload = JSON.stringify({
        secret: envConfig.PLANBOK_ORG_SECRET,
        timestamp: Date.now(),
        context: "verify",
    });
    return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(payload)).toString("base64");
};
// Money is integer kobo everywhere except here: Planbok speaks naira.
export const toNaira = (kobo) => (kobo / 100).toFixed(2);
export const toKobo = (naira) => Math.round(Number(naira) * 100);
export const createAccount = async (idempotencyKey, refId, name, holder) => {
    const data = await planbok("/virtual-accounts", "POST", {
        idempotencyKey,
        encryptedOrganizationSecret: await encryptedSecret(),
        count: 1,
        metadata: [{ name, refId, currencies: ["NGN"], holderDetails: holder }],
    });
    if (data.failed.length)
        console.error(`Planbok did not open ${refId}:`, JSON.stringify(data.failed));
    return data.created[0];
};
export const findAccount = async (refId) => {
    const data = await planbok(`/virtual-accounts?refId=${encodeURIComponent(refId)}`);
    return data.items[0];
};
export const getBalance = async (accountId) => {
    const data = await planbok(`/virtual-accounts/${accountId}/balance`);
    return { booked: toKobo(data.bookedBalance), available: toKobo(data.availableBalance) };
};
export const listBanks = async () => (await planbok("/virtual-accounts/banks?order=ASC")).banks;
export const nameEnquiry = (accountNumber, sortCode) => planbok(`/virtual-accounts/name/enquiry?accountNumber=${accountNumber}&sortCode=${sortCode}`);
export const transfer = async (accountId, idempotencyKey, amount, destinationType, destination, narration) => planbok(`/virtual-accounts/${accountId}/transfer`, "POST", {
    idempotencyKey,
    encryptedOrganizationSecret: await encryptedSecret(),
    amount: toNaira(amount),
    destinationType,
    destination,
    narration,
});
//# sourceMappingURL=planbok.service.js.map