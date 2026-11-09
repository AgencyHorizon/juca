import { config } from "../config.js";

/**
 * Passagens aéreas via SerpApi (dados do Google Flights, que inclui GOL, LATAM e Azul).
 * Só consulta preços: a compra é feita pela pessoa, no site da companhia.
 */
export const flightsConfigured = () => !!config.SERPAPI_KEY;

export interface FlightQuery {
  origin: string;
  destination: string;
  outboundDate: string;
  returnDate?: string | null;
  adults?: number;
  maxPrice?: number | null;
  nonstopOnly?: boolean;
}

export function flightParams(q: FlightQuery): URLSearchParams {
  const p = new URLSearchParams({
    engine: "google_flights",
    api_key: config.SERPAPI_KEY,
    departure_id: q.origin.trim().toUpperCase(),
    arrival_id: q.destination.trim().toUpperCase(),
    outbound_date: q.outboundDate,
    type: q.returnDate ? "1" : "2",
    adults: String(q.adults ?? 1),
    currency: "BRL",
    hl: "pt-br",
    gl: "br",
  });
  if (q.returnDate) p.set("return_date", q.returnDate);
  if (q.maxPrice) p.set("max_price", String(q.maxPrice));
  if (q.nonstopOnly) p.set("stops", "1");
  return p;
}

interface Option {
  flights: { departure_airport: { id: string; time: string }; arrival_airport: { id: string; time: string }; airline: string; flight_number: string }[];
  layovers?: { id: string; duration: number }[];
  total_duration: number;
  price?: number;
}

const summarize = (o: Option) => ({
  price_brl: o.price,
  airlines: [...new Set(o.flights.map((f) => f.airline))].join(" + "),
  flight_numbers: o.flights.map((f) => f.flight_number).join(", "),
  departs: o.flights[0]?.departure_airport.time,
  arrives: o.flights.at(-1)?.arrival_airport.time,
  duration_min: o.total_duration,
  stops: (o.layovers ?? []).map((l) => l.id),
});

export async function searchFlights(q: FlightQuery) {
  const res = await fetch(`https://serpapi.com/search?${flightParams(q)}`, { signal: AbortSignal.timeout(30_000) });
  const d = (await res.json()) as { error?: string; best_flights?: Option[]; other_flights?: Option[]; price_insights?: { lowest_price?: number; price_level?: string; typical_price_range?: number[] } };
  const all = [...(d.best_flights ?? []), ...(d.other_flights ?? [])].filter((o) => typeof o.price === "number");
  // A SerpApi devolve "error" também quando apenas não há resultados: sem voos e sem erro de HTTP, é lista vazia.
  if (!res.ok || (d.error && !all.length && !/no results|hasn't returned any results/i.test(d.error))) throw new Error(`voos ${res.status}: ${String(d.error).slice(0, 150)}`);
  all.sort((a, b) => a.price! - b.price!);
  return {
    trip: q.returnDate ? "ida e volta (preço total)" : "só ida",
    cheapest: all.slice(0, 5).map(summarize),
    found: all.length,
    lowest_price_brl: d.price_insights?.lowest_price,
    price_level: d.price_insights?.price_level,
    typical_range_brl: d.price_insights?.typical_price_range,
    source: "Google Flights via SerpApi",
    note: "Preços mudam a toda hora e podem variar na compra. O Juca não compra passagens.",
  };
}
