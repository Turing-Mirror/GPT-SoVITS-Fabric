// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../lib/config';
const mocks = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('../lib/config', () => ({ setConfig: mocks.set }));
import { useRoleParams } from './useRoleParams';

const A = { id: 'a', params: { speed: 1.2 } };
const B = { id: 'b', params: { top_k: 25 } };
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useRoleParams>;
let disk: Config;
function Harness({ role = A, cfg = disk }: { role?: NonNullable<Parameters<typeof useRoleParams>[0]>; cfg?: Config }) {
  state = useRoleParams(role, cfg, true);
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  disk = { synth_role_params: {} };
  mocks.set.mockReset().mockImplementation(async (patch: Config) => { disk = { ...disk, ...patch }; return { config: disk }; });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

describe('role parameter lifecycle', () => {
  it('saves basic and advanced values and restores A after B and remount', async () => {
    await act(async () => root.render(<Harness />));
    act(() => state.setDraft((p) => ({ ...p, speed: 1.6, seed: 24, seedFixed: true, text_lang: 'ja', sample_steps: '32' })));
    expect(state.dirty).toBe(true);
    await act(async () => state.save());
    expect(state.source).toBe('saved');
    expect(state.dirty).toBe(false);
    await act(async () => root.render(<Harness role={B} />));
    expect(state.draft.speed).toBe(1);
    expect(state.draft.seedFixed).toBe(false);
    expect(state.draft.top_k).toBe(25);
    await act(async () => root.render(<Harness />));
    expect(state.draft.speed).toBe(1.6);
    expect(state.draft.seed).toBe(24);
    await act(async () => root.render(null));
    await act(async () => root.render(<Harness />));
    expect(state.draft.speed).toBe(1.6);
    expect(state.draft.text_lang).toBe('ja');
    expect(state.draft.sample_steps).toBe('32');
  });
  it('keeps edits as a draft, and Restore persistently removes the override', async () => {
    disk = { synth_role_params: { a: { speed: 1.7 } }, synth_role: 'a', synth_speed: 1.9 };
    await act(async () => root.render(<Harness />));
    act(() => state.setDraft((p) => ({ ...p, speed: 1.8 })));
    await act(async () => root.render(<Harness role={B} />));
    await act(async () => root.render(<Harness />));
    expect(state.draft.speed).toBe(1.7);
    await act(async () => state.restore());
    expect(state.draft.speed).toBe(1.2);
    expect(state.source).toBe('recommended');
    expect(disk.synth_role_params).toEqual({});
    await act(async () => root.render(null));
    await act(async () => root.render(<Harness />));
    expect(state.draft.speed).toBe(1.2);
  });
  it('keeps failed saves edited, and failed Restore retains saved values', async () => {
    await act(async () => root.render(<Harness />));
    act(() => state.setDraft((p) => ({ ...p, speed: 1.8 })));
    mocks.set.mockRejectedValueOnce(new Error('write failed'));
    await act(async () => state.save());
    expect(state.error).toContain('write failed');
    expect(state.source).toBe('recommended');
    expect(state.dirty).toBe(true);
    await act(async () => state.save());
    mocks.set.mockRejectedValueOnce(new Error('restore failed'));
    await act(async () => state.restore());
    expect(state.draft.speed).toBe(1.8);
    expect(state.source).toBe('saved');
  });
  it('does not apply a delayed Restore to the newly selected role', async () => {
    disk = { synth_role_params: { a: { speed: 1.8 } } };
    await act(async () => root.render(<Harness />));
    let finish!: (value: unknown) => void;
    mocks.set.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => { void state.restore(); });
    await act(async () => root.render(<Harness role={B} />));
    act(() => state.setDraft((p) => ({ ...p, top_k: 40 })));
    await act(async () => finish({}));
    expect(state.draft.top_k).toBe(40);
    expect(state.draft.speed).toBe(1);
    await act(async () => root.render(<Harness />));
    expect(state.draft.speed).toBe(1.2);
  });
  it('keeps a newly selected role unchanged when an earlier Save completes', async () => {
    await act(async () => root.render(<Harness />));
    act(() => state.setDraft((p) => ({ ...p, speed: 1.8 })));
    let finish!: (value: unknown) => void;
    mocks.set.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => { void state.save(); });
    await act(async () => root.render(<Harness role={B} />));
    await act(async () => finish({}));
    expect(state.draft.top_k).toBe(25);
    expect(state.draft.speed).toBe(1);
    await act(async () => root.render(<Harness />));
    expect(state.draft.speed).toBe(1.8);
  });
  it('labels missing recommendations as defaults and keeps drafts on metadata refresh', async () => {
    const empty = { id: 'empty', params: {} };
    await act(async () => root.render(<Harness role={empty} />));
    expect(state.source).toBe('default');
    act(() => state.setDraft((p) => ({ ...p, speed: 1.4 })));
    await act(async () => root.render(<Harness role={{ ...empty, params: {} }} />));
    expect(state.draft.speed).toBe(1.4);
    expect(state.dirty).toBe(true);
  });
  it('migrates only the legacy selected role even when another role opens first', async () => {
    disk = { synth_role: 'a', synth_speed: 1.8, synth_seed_fixed: true, synth_seed: 23 };
    await act(async () => root.render(<Harness role={B} />));
    expect(state.draft.speed).toBe(1);
    expect(state.draft.seedFixed).toBe(false);
    await act(async () => root.render(<Harness />));
    expect(state.draft.speed).toBe(1.8);
    expect(state.draft.seed).toBe(23);
    expect(disk.synth_role_params).toEqual({ a: { speed: 1.8, seedFixed: true, seed: 23 } });
  });
});

