import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
/**
 * Flutterwave answered and said no: nothing was sent, so trying again later is safe.
 * Anything else that goes wrong (a timeout, a 5xx) leaves it unknown whether the
 * transfer exists, and that must not be retried blind.
 */
export class TransferRejected extends Error {
}
const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${envConfig.FLW_SECRET_KEY}`,
};
export const createTransfer = async (input) => {
    const response = await fetch(`${envConfig.FLW_BASE_URL}/transfers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            account_bank: input.bankCode,
            account_number: input.accountNumber,
            amount: input.amount,
            narration: input.narration,
            currency: "NGN",
            debit_currency: "NGN",
            reference: input.reference,
        }),
    });
    const body = (await response.json().catch(() => ({})));
    if (response.status >= 400 && response.status < 500)
        throw new TransferRejected(body.message ?? `Transfer refused (${response.status})`);
    if (!response.ok || body.status !== "success" || !body.data)
        throw new Error(body.message ?? `Transfer service error (${response.status})`);
    return body.data;
};
export const refundDone = (refund) => refund.status.startsWith("completed");
/**
 * Returns a charge to the payer's original method, out of INSPECTRA's balance. The
 * same rule as a transfer: a 4xx means Flutterwave said no, so nothing was refunded.
 */
export const createRefund = async (transactionId, amount) => {
    const response = await fetch(`${envConfig.FLW_BASE_URL}/transactions/${transactionId}/refund`, {
        method: "POST",
        headers,
        body: JSON.stringify({ amount, comments: "INSPECTRA inspection refund" }),
    });
    const body = (await response.json().catch(() => ({})));
    if (response.status >= 400 && response.status < 500)
        throw new TransferRejected(body.message ?? `Refund refused (${response.status})`);
    if (!response.ok || body.status !== "success" || !body.data)
        throw new Error(body.message ?? `Refund service error (${response.status})`);
    return body.data;
};
/** A refund as Flutterwave holds it. Refund webhooks are off by default, so this is polled. */
export const getRefund = async (id) => {
    const response = await fetch(`${envConfig.FLW_BASE_URL}/refunds/${id}`, { headers });
    const body = (await response.json().catch(() => ({})));
    if (!response.ok || !body.data)
        throw new Error(`Could not read refund ${id}`);
    return body.data;
};
/** The transfer as Flutterwave holds it. Trusted over any webhook body. */
export const getTransfer = async (id) => {
    const response = await fetch(`${envConfig.FLW_BASE_URL}/transfers/${id}`, { headers });
    const body = (await response.json().catch(() => ({})));
    if (!response.ok || !body.data)
        throw new Error(`Could not read transfer ${id}`);
    return body.data;
};
// CLIENT_URL is written with a trailing slash in some environments, and appending a path
// to it would give a double slash the router never matches.
const clientOrigin = envConfig.CLIENT_URL.replace(/\/+$/, "");
/** Opens a hosted checkout and hands back the link to send the payer to. `returnPath` is
 *  a client route; the client origin, not the API, so a session cookie stays first-party. */
export const createCheckout = async (input) => {
    const response = await fetch(`${envConfig.FLW_BASE_URL}/payments`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            tx_ref: input.reference,
            amount: input.amount,
            currency: input.currency,
            redirect_url: `${clientOrigin}${input.returnPath}`,
            customer: {
                email: input.customer.email,
                name: input.customer.name,
                phonenumber: input.customer.phone ?? "",
            },
            // Flutterwave fetches the logo itself, so it has to be a public URL. The symbol,
            // not the wordmark: the checkout sets it beside the title in a small square.
            customizations: {
                title: "INSPECTRA",
                description: input.description,
                logo: `${clientOrigin}/inspectra-symbol.png`,
            },
            // No payment_plan: that would pin the method to card, and bank transfer and USSD
            // carry real volume here. meta carries enough to rebuild the row from nothing.
            meta: input.meta,
        }),
    });
    if (!response.ok)
        throw new AppError("We could not reach the payment service. Try again.", 502);
    const body = (await response.json());
    if (body.status !== "success" || !body.data?.link)
        throw new AppError("We could not start that payment. Try again.", 502);
    return body.data.link;
};
/**
 * Reads a transaction back from Flutterwave.
 *
 * Nothing is credited on anybody's say-so: not the browser's, which can put any
 * transaction id in the URL, and not the webhook's, whose header proves the sender but
 * says nothing about the amount. This call is the only trusted thing about a payment.
 */
export const verifyTransaction = async (id) => {
    const response = await fetch(`${envConfig.FLW_BASE_URL}/transactions/${id}/verify`, {
        headers,
    });
    // Flutterwave answers 400, not 404, for an id it has never seen. Both mean the id is
    // wrong rather than the service being down.
    if (response.status === 400 || response.status === 404)
        throw new AppError("We could not find that payment.", 404);
    if (!response.ok)
        throw new AppError("We could not reach the payment service. Try again.", 502);
    const body = (await response.json());
    if (!body.data)
        throw new AppError("We could not find that payment.", 404);
    return body.data;
};
//# sourceMappingURL=flutterwave.service.js.map