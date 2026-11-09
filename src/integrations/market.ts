import { config } from "../config.js";
import { formatLocal } from "../core/time.js";

/** Cotações por APIs públicas: B3 (brapi), câmbio (AwesomeAPI) e cripto (CoinGecko). */
const get = async (url: string, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`cotação ${new URL(url).hostname} ${res.status}`);
  return res.json() as Promise<any>;
};

export const normalizeTicker = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9^.]/g, "");

/** as_of já sai no fuso da pessoa: a API devolve UTC e o modelo erra a conversão. */
export async function stockQuotes(symbols: string[], tz: string) {
  const qs = new URLSearchParams({ symbols: symbols.map(normalizeTicker).slice(0, 10).join(",") });
  const d = await get(`https://brapi.dev/api/v2/stocks/quote?${qs}`, config.BRAPI_TOKEN ? { authorization: `Bearer ${config.BRAPI_TOKEN}` } : {});
  return {
    results: (d.results ?? []).map((r: any) =>
      r.data
        ? {
            symbol: r.symbol,
            name: r.data.longName ?? r.data.shortName,
            price: r.data.regularMarketPrice,
            currency: r.data.currency,
            change_pct: r.data.regularMarketChangePercent,
            day_low: r.data.regularMarketDayLow,
            day_high: r.data.regularMarketDayHigh,
            as_of: r.data.regularMarketTime ? formatLocal(r.data.regularMarketTime, tz) : null,
          }
        : { symbol: r.symbol ?? r.requestedSymbol, error: "não encontrado ou indisponível sem token" },
    ),
    source: "brapi.dev",
    note: "Informe a data de as_of: a cotação pode não ser em tempo real. Não é recomendação de investimento.",
  };
}

export async function fxRates(pairs: string[]) {
  const list = pairs.map((p) => p.trim().toUpperCase().replace(/[^A-Z]+/g, "-")).slice(0, 5);
  const d = await get(`https://economia.awesomeapi.com.br/json/last/${list.join(",")}`);
  return { results: Object.values(d).map((r: any) => ({ pair: `${r.code}/${r.codein}`, bid: Number(r.bid), ask: Number(r.ask), change_pct: Number(r.pctChange), as_of: r.create_date })), source: "AwesomeAPI" };
}

export async function cryptoPrices(ids: string[]) {
  const qs = new URLSearchParams({ ids: ids.map((i) => i.trim().toLowerCase()).slice(0, 10).join(","), vs_currencies: "brl,usd", include_24hr_change: "true" });
  const d = await get(`https://api.coingecko.com/api/v3/simple/price?${qs}`);
  return { results: Object.entries(d).map(([id, v]: [string, any]) => ({ id, brl: v.brl, usd: v.usd, change_24h_pct: v.brl_24h_change })), source: "CoinGecko" };
}
