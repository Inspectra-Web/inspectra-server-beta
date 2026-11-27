import { getPricing } from "./lambacard.service.js";

/**
 * What LBT and BNB are worth, so realtors see naira and dollars beside their tokens. LBT is
 * priced by LambaCard, who sell it; BNB by CoinGecko's public market price. Each is fetched
 * on its own and kept for five minutes. A price that cannot be fetched is null, never an
 * old or guessed one, and the page leaves its value line off.
 */

/** Naira and dollars per token, as decimal strings. A missing currency is null. */
export interface TokenPrice {
  ngn: string | null;
  usd: string | null;
}

export type PricedSymbol = "LBT" | "BNB";

const KEEP_FOR = 5 * 60 * 1000;
const COINGECKO_BNB =
  "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd,ngn";

const lbtPrice = async (): Promise<TokenPrice | null> => {
  const pricing = await getPricing();
  if (!pricing) return null;

  return { ngn: pricing.priceNgnPerLbt, usd: pricing.priceUsdPerLbt };
};

const bnbPrice = async (): Promise<TokenPrice | null> => {
  const response = await fetch(COINGECKO_BNB, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`CoinGecko answered ${response.status}`);

  const body = (await response.json()) as { binancecoin?: { usd?: number; ngn?: number } };
  const { usd, ngn } = body.binancecoin ?? {};
  if (typeof usd !== "number" && typeof ngn !== "number") throw new Error("CoinGecko sent no BNB price");

  return {
    ngn: typeof ngn === "number" ? String(ngn) : null,
    usd: typeof usd === "number" ? String(usd) : null,
  };
};

const SOURCES: Record<PricedSymbol, () => Promise<TokenPrice | null>> = { LBT: lbtPrice, BNB: bnbPrice };

interface Kept {
  price: TokenPrice | null;
  at: number;
}

const kept = new Map<PricedSymbol, Kept>();
const inFlight = new Map<PricedSymbol, Promise<TokenPrice | null>>();

/** One token's price, from the last five minutes or fetched now. Concurrent asks share one fetch. */
const priceOf = (symbol: PricedSymbol): Promise<TokenPrice | null> => {
  const hit = kept.get(symbol);
  if (hit && Date.now() - hit.at < KEEP_FOR) return Promise.resolve(hit.price);

  const pending = inFlight.get(symbol);
  if (pending) return pending;

  const fetching = SOURCES[symbol]()
    .then((price) => {
      kept.set(symbol, { price, at: Date.now() });
      return price;
    })
    .catch((error: unknown) => {
      // Not kept: the next ask tries again rather than showing nothing for five minutes.
      console.error(`${symbol} price unavailable: ${(error as Error).message}`);
      return null;
    })
    .finally(() => inFlight.delete(symbol));

  inFlight.set(symbol, fetching);
  return fetching;
};

export const getPrices = async (): Promise<Record<PricedSymbol, TokenPrice | null>> => {
  const [LBT, BNB] = await Promise.all([priceOf("LBT"), priceOf("BNB")]);
  return { LBT, BNB };
};
