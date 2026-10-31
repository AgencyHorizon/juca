import { query } from "../db/pool.js";

// RF-33: precedência usuário > coorte > global > padrão.
export const FLAG_DEFAULTS: Record<string, boolean> = {
  web_search: true,
  link_summary: true,
  voice_transcription: true, // só atua se houver NVIDIA_API_KEY ou HF_TOKEN configurado
  recurring_reminders: true,
  persistent_memory: true,
};

export async function isEnabled(flag: string, user: { id: number; cohort: string }): Promise<boolean> {
  const { rows } = await query<{ scope: string; enabled: boolean }>(
    "SELECT scope, enabled FROM feature_flags WHERE key = $1 AND scope = ANY($2)",
    [flag, [`user:${user.id}`, `cohort:${user.cohort}`, "global"]],
  );
  for (const scope of [`user:${user.id}`, `cohort:${user.cohort}`, "global"]) {
    const hit = rows.find((r) => r.scope === scope);
    if (hit) return hit.enabled;
  }
  return FLAG_DEFAULTS[flag] ?? false;
}

export async function setFlag(flag: string, scope: string, enabled: boolean) {
  await query(
    `INSERT INTO feature_flags(key, scope, enabled) VALUES ($1,$2,$3)
     ON CONFLICT (key, scope) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [flag, scope, enabled],
  );
}
