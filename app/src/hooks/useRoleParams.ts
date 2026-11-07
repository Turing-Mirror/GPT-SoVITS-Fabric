import { useEffect, useRef, useState } from 'react';
import { setConfig, type Config } from '../lib/config';
import { cleanParams, recommendedParams, ROLE_PARAMS_KEY, roleParamsFromConfig, sameParams, SYNTH_DEFAULTS, type SavedRoleParams, type SynthParams } from '../lib/synthRoleParams';

type Role = { id: string; params: Partial<SynthParams> };
export function useRoleParams(role: Role | null, cfg: Config, loaded: boolean) {
  const [saved, setSaved] = useState<SavedRoleParams | null>(null);
  const [draft, setDraft] = useState<SynthParams>(SYNTH_DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const active = useRef('');
  const initialized = useRef(false);
  const recommendation = recommendedParams(role?.params);
  const baseline = { ...recommendation, ...(role ? saved?.[role.id] : {}) };
  const fingerprint = JSON.stringify(recommendation);
  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;
    const next = roleParamsFromConfig(cfg);
    setSaved(next);
    if (!Object.prototype.hasOwnProperty.call(cfg, ROLE_PARAMS_KEY)) {
      void setConfig({ [ROLE_PARAMS_KEY]: next }).catch((e) => setError(String(e)));
    }
  }, [cfg, loaded]);
  useEffect(() => {
    if (saved === null) return;
    active.current = role?.id ?? '';
    setDraft({ ...recommendedParams(role?.params), ...(role ? saved[role.id] : {}) });
    // Saved changes are applied explicitly after a successful write. Refreshing role
    // metadata re-resolves recommendations; ordinary config echoes retain the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role?.id, fingerprint, saved === null]);
  async function persist(reset: boolean) {
    if (!role || saved === null || saving) return;
    const id = role.id;
    const next = { ...saved };
    if (reset) delete next[id];
    else next[id] = cleanParams(draft);
    const applied = reset ? recommendation : draft;
    setSaving(true);
    setError('');
    try {
      await setConfig({ [ROLE_PARAMS_KEY]: next });
      setSaved(next);
      if (active.current === id && reset) setDraft(applied);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  const source = role && saved?.[role.id] ? 'saved'
    : Object.keys(cleanParams(role?.params)).length ? 'recommended' : 'default';
  return { draft, setDraft, recommendation, dirty: !sameParams(draft, baseline), source,
    ready: saved !== null, saving, error, save: () => persist(false), restore: () => persist(true) };
}

