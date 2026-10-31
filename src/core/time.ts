import { DateTime } from "luxon";

/**
 * Converte uma data/hora LOCAL do usuário ("2026-11-01T15:00") para UTC.
 * O modelo sempre informa horários no fuso do usuário (RN-23); a conversão é determinística aqui.
 */
export function localToUtc(local: string, tz: string): DateTime | null {
  const dt = DateTime.fromISO(local, { zone: tz });
  return dt.isValid ? dt.toUTC() : null;
}

export function formatLocal(utc: Date | string, tz: string): string {
  const dt = typeof utc === "string" ? DateTime.fromISO(utc) : DateTime.fromJSDate(utc);
  return dt.setZone(tz).setLocale("pt-BR").toFormat("ccc, dd/LL 'às' HH:mm");
}

export function nowLocalDescription(tz: string, now = DateTime.now()): string {
  return now.setZone(tz).setLocale("pt-BR").toFormat("cccc, dd 'de' LLLL 'de' yyyy, HH:mm") + ` (${tz})`;
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

const DAYS: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

/**
 * RF-24: subconjunto de RRULE suportado no MVP.
 *   FREQ=DAILY | FREQ=WEEKLY;BYDAY=MO,WE | FREQ=MONTHLY | FREQ=WEEKDAYS (seg–sex)
 */
export function parseRrule(rrule: string): { freq: string; byDay: number[] } | null {
  const parts = Object.fromEntries(
    rrule.toUpperCase().split(";").map((p) => p.split("=") as [string, string]),
  );
  const freq = parts.FREQ;
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "WEEKDAYS"].includes(freq)) return null;
  const byDay = (parts.BYDAY ?? "")
    .split(",")
    .filter(Boolean)
    .map((d) => DAYS[d]);
  if (byDay.some((d) => d === undefined)) return null;
  return { freq, byDay: byDay as number[] };
}

/** Próxima ocorrência estritamente depois de `after`, mantendo o horário local (respeita horário de verão). */
export function nextOccurrence(rrule: string, previousDueUtc: Date, tz: string, after = new Date()): Date | null {
  const rule = parseRrule(rrule);
  if (!rule) return null;
  let cur = DateTime.fromJSDate(previousDueUtc).setZone(tz);
  const limit = DateTime.fromJSDate(after);
  for (let i = 0; i < 1000; i++) {
    switch (rule.freq) {
      case "DAILY":
        cur = cur.plus({ days: 1 });
        break;
      case "MONTHLY":
        cur = cur.plus({ months: 1 });
        break;
      case "WEEKDAYS":
        cur = cur.plus({ days: 1 });
        if (cur.weekday > 5) continue;
        break;
      case "WEEKLY":
        cur = cur.plus({ days: 1 });
        if (rule.byDay.length ? !rule.byDay.includes(cur.weekday) : cur.weekday !== DateTime.fromJSDate(previousDueUtc).setZone(tz).weekday) continue;
        break;
    }
    if (cur > limit) return cur.toUTC().toJSDate();
  }
  return null;
}
