import type { Config } from './config';

export const ROLE_PARAMS_KEY = 'synth_role_params';
export const SYNTH_DEFAULTS = {
  speed: 1, top_k: 15, top_p: 1, temperature: 1, repetition_penalty: 1.35,
  text_lang: 'auto', text_split_method: '', fragment_interval: 0.3,
  seed: -1, seedFixed: false, sample_steps: '', super_sampling: false,
};
export type SynthParams = typeof SYNTH_DEFAULTS;
export type SavedRoleParams = Record<string, Partial<SynthParams>>;
const KEYS = Object.keys(SYNTH_DEFAULTS) as Array<keyof SynthParams>;
const NUM_RANGES: Partial<Record<keyof SynthParams, [number, number]>> = {
  speed: [0.5, 2], top_k: [1, 100], top_p: [0, 1], temperature: [0, 1],
  repetition_penalty: [1, 2], fragment_interval: [0.01, 1], seed: [-1, 2147483647],
};
const OPTIONS: Partial<Record<keyof SynthParams, string[]>> = {
  text_lang: ['auto', 'auto_yue', 'all_zh', 'zh', 'en', 'all_ja', 'ja', 'all_yue', 'yue', 'all_ko', 'ko'],
  text_split_method: ['', 'cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5'],
  sample_steps: ['', '4', '8', '16', '32', '64', '128'],
};
export function cleanParams(value: unknown): Partial<SynthParams> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean: Record<string, unknown> = {};
  for (const key of KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v !== typeof SYNTH_DEFAULTS[key]) continue;
    const range = NUM_RANGES[key];
    if (typeof v === 'number' && (!Number.isFinite(v) || (range && (v < range[0] || v > range[1])))) continue;
    if ((key === 'seed' || key === 'top_k') && !Number.isInteger(v)) continue;
    if (OPTIONS[key] && !OPTIONS[key]!.includes(v as string)) continue;
    clean[key] = v;
  }
  return clean;
}
export function recommendedParams(value: unknown): SynthParams {
  return { ...SYNTH_DEFAULTS, ...cleanParams(value) };
}
export function sameParams(a: SynthParams, b: SynthParams): boolean {
  return KEYS.every((k) => a[k] === b[k]);
}
const LEGACY_KEYS: Record<keyof SynthParams, string> = {
  speed: 'synth_speed', top_k: 'synth_top_k', top_p: 'synth_top_p', temperature: 'synth_temperature',
  repetition_penalty: 'synth_rep_penalty', text_lang: 'synth_text_lang', text_split_method: 'synth_split',
  fragment_interval: 'synth_fragment_interval', seed: 'synth_seed', seedFixed: 'synth_seed_fixed',
  sample_steps: 'synth_sample_steps', super_sampling: 'synth_super_sampling',
};
export function roleParamsFromConfig(cfg: Config): SavedRoleParams {
  const raw = cfg[ROLE_PARAMS_KEY];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw).flatMap(([id, value]) => {
      const clean = cleanParams(value);
      return Object.keys(clean).length ? [[id, clean]] : [];
    }));
  }
  // Presence is the migration marker, including an empty map after Restore.
  if (Object.prototype.hasOwnProperty.call(cfg, ROLE_PARAMS_KEY) || typeof cfg.synth_role !== 'string' || !cfg.synth_role) return {};
  const old = Object.fromEntries(KEYS.map((k) => [k, cfg[LEGACY_KEYS[k]]]));
  if (typeof old.sample_steps === 'number') old.sample_steps = String(old.sample_steps);
  const migrated = cleanParams(old);
  return Object.keys(migrated).length ? { [cfg.synth_role]: migrated } : {};
}

