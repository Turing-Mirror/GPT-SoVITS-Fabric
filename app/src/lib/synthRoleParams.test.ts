import { describe, expect, it } from 'vitest';
import { cleanParams, recommendedParams, roleParamsFromConfig, SYNTH_DEFAULTS } from './synthRoleParams';

describe('role parameter persistence', () => {
  it('fills partial author recommendations from application defaults', () => {
    expect(recommendedParams({ speed: 1.4 })).toEqual({ ...SYNTH_DEFAULTS, speed: 1.4 });
  });
  it('migrates legacy values only to the matching last role and ignores global settings', () => {
    expect(roleParamsFromConfig({ synth_role: 'alice', synth_speed: 1.4, synth_seed: 42,
      synth_seed_fixed: true, synth_sample_steps: 32, synth_batch_size: 50, synth_format: 'flac' }))
      .toEqual({ alice: { speed: 1.4, seed: 42, seedFixed: true, sample_steps: '32' } });
    expect(roleParamsFromConfig({ synth_speed: 1.4 })).toEqual({});
  });
  it('does not resurrect legacy parameters after Restore or for invalid saved maps', () => {
    for (const saved of [{}, null, [], 'broken']) {
      expect(roleParamsFromConfig({ synth_role_params: saved, synth_role: 'alice', synth_speed: 1.4 })).toEqual({});
    }
  });
  it('rejects malformed and unsupported fields without discarding valid recommendations', () => {
    expect(cleanParams({ speed: NaN, top_k: 1.5, top_p: 2, temperature: -1, seed: Infinity,
      text_lang: 'invalid', sample_steps: '31', seedFixed: 'true', super_sampling: true,
      batch_size: 99, output: 'flac', fragment_interval: 0.4 })).toEqual({ super_sampling: true, fragment_interval: 0.4 });
    expect(roleParamsFromConfig({ synth_role_params: { a: null, b: [], c: { speed: 1.2, batch_size: 40 } } }))
      .toEqual({ c: { speed: 1.2 } });
  });
});
