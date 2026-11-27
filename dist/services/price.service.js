import { getPricing } from "./lambacard.service.js";
const KEEP_FOR = 5 * 60 * 1000;
const COINGECKO_BNB = "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd,ngn";
const lbtPrice = async () => {
    const pricing = await getPricing();
    if (!pricing)
        return null;
    return { ngn: pricing.priceNgnPerLbt, usd: pricing.priceUsdPerLbt };
};
const bnbPrice = async () => {
    const response = await fetch(COINGECKO_BNB, { headers: { Accept: "application/json" } });
    if (!response.ok)
        throw new Error(`CoinGecko answered ${response.status}`);
    const body = (await response.json());
    const { usd, ngn } = body.binancecoin ?? {};
    if (typeof usd !== "number" && typeof ngn !== "number")
        throw new Error("CoinGecko sent no BNB price");
    return {
        ngn: typeof ngn === "number" ? String(ngn) : null,
        usd: typeof usd === "number" ? String(usd) : null,
    };
};
const SOURCES = { LBT: lbtPrice, BNB: bnbPrice };
const kept = new Map();
const inFlight = new Map();
/** One token's price, from the last five minutes or fetched now. Concurrent asks share one fetch. */
const priceOf = (symbol) => {
    const hit = kept.get(symbol);
    if (hit && Date.now() - hit.at < KEEP_FOR)
        return Promise.resolve(hit.price);
    const pending = inFlight.get(symbol);
    if (pending)
        return pending;
    const fetching = SOURCES[symbol]()
        .then((price) => {
        kept.set(symbol, { price, at: Date.now() });
        return price;
    })
        .catch((error) => {
        // Not kept: the next ask tries again rather than showing nothing for five minutes.
        console.error(`${symbol} price unavailable: ${error.message}`);
        return null;
    })
        .finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, fetching);
    return fetching;
};
export const getPrices = async () => {
    const [LBT, BNB] = await Promise.all([priceOf("LBT"), priceOf("BNB")]);
    return { LBT, BNB };
};
//# sourceMappingURL=price.service.js.map