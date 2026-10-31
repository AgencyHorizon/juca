import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Ferramentas web locais (RF-14 / RF-15) para provedores sem ferramentas de servidor.
 * O conteúdo retornado é DADO não confiável — o prompt instrui o modelo a não seguir ordens dele.
 */
const UA = "Mozilla/5.0 (compatible; JucaBot/1.0; +https://juca.app)";
const MAX_CHARS = 6000;

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Busca web via Brave Search API (oficial, plano gratuito disponível). Só é oferecida ao modelo
 * quando BRAVE_SEARCH_API_KEY está configurada — não fazemos scraping de buscadores.
 */
export async function webSearch(apiKey: string, query: string, max = 5): Promise<{ title: string; url: string; snippet: string }[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.search = new URLSearchParams({ q: query.slice(0, 300), count: String(max), country: "BR", search_lang: "pt-br" }).toString();
  const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": apiKey }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`busca ${res.status}`);
  const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (data.web?.results ?? []).slice(0, max).map((r) => ({ title: decode(r.title), url: r.url, snippet: decode(r.description ?? "") }));
}

// Códigos WMO usados pelo Open-Meteo
const WMO: Record<number, string> = {
  0: "céu limpo", 1: "predominantemente limpo", 2: "parcialmente nublado", 3: "nublado", 45: "nevoeiro", 48: "nevoeiro com geada",
  51: "garoa fraca", 53: "garoa", 55: "garoa forte", 61: "chuva fraca", 63: "chuva", 65: "chuva forte", 66: "chuva congelante", 67: "chuva congelante forte",
  71: "neve fraca", 73: "neve", 75: "neve forte", 80: "pancadas de chuva fracas", 81: "pancadas de chuva", 82: "pancadas de chuva fortes",
  95: "trovoadas", 96: "trovoadas com granizo", 99: "trovoadas fortes com granizo",
};

/** Previsão do tempo via Open-Meteo (API pública e gratuita, sem chave). */
export async function weatherForecast(city: string, days = 3) {
  const geo = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geo.search = new URLSearchParams({ name: city.slice(0, 100), count: "1", language: "pt" }).toString();
  const g = (await (await fetch(geo, { signal: AbortSignal.timeout(8_000) })).json()) as {
    results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number; timezone: string }[];
  };
  const place = g.results?.[0];
  if (!place) return null;
  const fc = new URL("https://api.open-meteo.com/v1/forecast");
  fc.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    current: "temperature_2m,weather_code",
    timezone: place.timezone,
    forecast_days: String(Math.min(Math.max(days, 1), 7)),
  }).toString();
  const f = (await (await fetch(fc, { signal: AbortSignal.timeout(8_000) })).json()) as any;
  return {
    place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
    now: f.current ? { temp_c: f.current.temperature_2m, condition: WMO[f.current.weather_code] ?? "?" } : null,
    days: (f.daily?.time ?? []).map((date: string, i: number) => ({
      date,
      condition: WMO[f.daily.weather_code[i]] ?? "?",
      min_c: f.daily.temperature_2m_min[i],
      max_c: f.daily.temperature_2m_max[i],
      rain_chance_pct: f.daily.precipitation_probability_max[i],
      rain_mm: f.daily.precipitation_sum[i],
    })),
    source: "Open-Meteo",
  };
}

/** Bloqueia SSRF: só http(s) em portas padrão e IPs públicos. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("só http/https");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("porta não permitida");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const a of addrs) if (isPrivate(a)) throw new Error("endereço não permitido");
  return url;
}

export function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Baixa uma página e devolve o texto principal (para resumo de links). */
export async function webFetch(raw: string): Promise<{ url: string; title: string; text: string }> {
  let url = await assertPublicUrl(raw);
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,text/plain" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = await assertPublicUrl(new URL(loc, url).toString()); // revalida cada redirecionamento
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw new Error(`página respondeu ${res?.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/(html|plain)/.test(type)) throw new Error("conteúdo não é texto");
  const html = (await res.text()).slice(0, 2_000_000);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n");
  return { url: url.toString(), title, text: decode(body).slice(0, MAX_CHARS) };
}
