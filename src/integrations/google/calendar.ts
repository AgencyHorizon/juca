import { getAccessToken } from "../oauth.js";

/** Google Calendar (agenda principal). Horários são sempre locais + fuso IANA da pessoa. */
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

async function cal<T>(userId: number, path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken(userId, "google");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`calendar ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface GEvent {
  id: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string }[];
}

export interface EventInput {
  title: string;
  startLocal: string;
  endLocal: string;
  timezone: string;
  location?: string | null;
  description?: string | null;
  attendees?: string[];
}

const withSeconds = (s: string) => (s.length === 16 ? `${s}:00` : s);

export function eventBody(e: EventInput) {
  return {
    summary: e.title,
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description } : {}),
    start: { dateTime: withSeconds(e.startLocal), timeZone: e.timezone },
    end: { dateTime: withSeconds(e.endLocal), timeZone: e.timezone },
    ...(e.attendees?.length ? { attendees: e.attendees.map((email) => ({ email })) } : {}),
  };
}

export async function listEvents(userId: number, p: { timeMinIso: string; timeMaxIso: string; timezone: string; query?: string | null }) {
  const qs = new URLSearchParams({ timeMin: p.timeMinIso, timeMax: p.timeMaxIso, singleEvents: "true", orderBy: "startTime", maxResults: "25", timeZone: p.timezone });
  if (p.query) qs.set("q", p.query);
  const d = await cal<{ items?: GEvent[] }>(userId, `?${qs}`);
  return d.items ?? [];
}

export const getEvent = (userId: number, id: string) => cal<GEvent>(userId, `/${encodeURIComponent(id)}`);

export function createEvent(userId: number, e: EventInput) {
  return cal<GEvent>(userId, `?sendUpdates=${e.attendees?.length ? "all" : "none"}`, { method: "POST", body: JSON.stringify(eventBody(e)) });
}

export interface EventPatch {
  title?: string | null;
  startLocal?: string | null;
  endLocal?: string | null;
  timezone: string;
}

export function patchBody(p: EventPatch) {
  return {
    ...(p.title ? { summary: p.title } : {}),
    ...(p.startLocal ? { start: { dateTime: withSeconds(p.startLocal), timeZone: p.timezone } } : {}),
    ...(p.endLocal ? { end: { dateTime: withSeconds(p.endLocal), timeZone: p.timezone } } : {}),
  };
}

export const updateEvent = (userId: number, id: string, p: EventPatch, notify: boolean) =>
  cal<GEvent>(userId, `/${encodeURIComponent(id)}?sendUpdates=${notify ? "all" : "none"}`, { method: "PATCH", body: JSON.stringify(patchBody(p)) });

export const deleteEvent =(userId: number, id: string, notify: boolean) =>
  cal<void>(userId, `/${encodeURIComponent(id)}?sendUpdates=${notify ? "all" : "none"}`, { method: "DELETE" });
