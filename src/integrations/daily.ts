/**
 * Ações do dia a dia. Uber, 99 e iFood não oferecem API aberta para consumidor: o Juca prepara o link
 * que abre o app no ponto certo e a pessoa confirma e paga lá. Consultas usam APIs públicas.
 */
export const APPS = ["uber", "99", "waze", "google_maps", "ifood", "rappi", "mercado_livre", "amazon", "booking", "whatsapp"] as const;
export type AppName = (typeof APPS)[number];

export interface Place {
  lat: string;
  lon: string;
  name: string;
}

/** Nominatim: uso baixo e identificado, conforme a política do OpenStreetMap. */
export async function geocode(q: string, uf: string): Promise<Place | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({ format: "jsonv2", limit: "5", addressdetails: "1", countrycodes: "br", "accept-language": "pt-BR", q: q.slice(0, 200) }).toString();
  const res = await fetch(url, { headers: { "user-agent": "JucaBot/1.0" }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const d = (await res.json()) as GeoResult[];
  const hit = pickInState(d, uf);
  return hit ? { lat: hit.lat, lon: hit.lon, name: hit.display_name } : null;
}

export interface GeoResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: { "ISO3166-2-lvl4"?: string };
}

/** Nomes se repetem pelo país ("Recife" também é localidade no Paraná): só aceita resultado no estado certo. */
export const pickInState = (results: GeoResult[], uf: string) => results.find((r) => r.address?.["ISO3166-2-lvl4"] === `BR-${uf.toUpperCase()}`) ?? null;

export function uberLink(destination: string, place: Place | null): string {
  const p = new URLSearchParams({ action: "setPickup", pickup: "my_location" });
  if (place) {
    p.set("dropoff[latitude]", place.lat);
    p.set("dropoff[longitude]", place.lon);
    p.set("dropoff[formatted_address]", destination);
  }
  return `https://m.uber.com/ul/?${p}`;
}

const q = encodeURIComponent;

export function appLink(app: AppName, a: { destination?: string | null; query?: string | null; phone?: string | null; message?: string | null; place?: Place | null }): string {
  const dest = a.destination ?? "";
  const term = a.query ?? "";
  switch (app) {
    case "uber":
      return uberLink(dest, a.place ?? null);
    case "99":
      return "https://99app.com/"; // sem link público documentado com destino
    case "waze":
      return a.place ? `https://waze.com/ul?ll=${a.place.lat},${a.place.lon}&navigate=yes` : `https://waze.com/ul?q=${q(dest)}&navigate=yes`;
    case "google_maps":
      return `https://www.google.com/maps/dir/?api=1&destination=${q(dest)}`;
    case "ifood":
      return "https://www.ifood.com.br/"; // sem link público documentado com busca
    case "rappi":
      return "https://www.rappi.com.br/";
    case "mercado_livre":
      return `https://lista.mercadolivre.com.br/${q(term.replace(/\s+/g, "-"))}`;
    case "amazon":
      return `https://www.amazon.com.br/s?k=${q(term)}`;
    case "booking":
      return `https://www.booking.com/searchresults.pt-br.html?ss=${q(dest || term)}`;
    case "whatsapp":
      return `https://wa.me/${(a.phone ?? "").replace(/\D/g, "")}?text=${q(a.message ?? "")}`;
  }
}

const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`brasilapi ${res.status}`);
  return res.json() as Promise<any>;
};

export async function lookupCep(cep: string) {
  const d = await get(`https://brasilapi.com.br/api/cep/v2/${cep.replace(/\D/g, "")}`);
  return d ? { cep: d.cep, street: d.street, neighborhood: d.neighborhood, city: d.city, state: d.state } : null;
}

/** Só dados da empresa: o quadro societário traz dados pessoais e fica de fora. */
export async function lookupCnpj(cnpj: string) {
  const d = await get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj.replace(/\D/g, "")}`);
  return d ? { razao_social: d.razao_social, nome_fantasia: d.nome_fantasia, situacao: d.descricao_situacao_cadastral, atividade: d.cnae_fiscal_descricao, municipio: d.municipio, uf: d.uf, abertura: d.data_inicio_atividade } : null;
}

export async function holidays(year: number): Promise<{ date: string; name: string }[]> {
  const d = await get(`https://brasilapi.com.br/api/feriados/v1/${year}`);
  return (d ?? []).map((h: any) => ({ date: h.date, name: h.name }));
}
