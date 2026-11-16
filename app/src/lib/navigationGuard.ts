type Guard = () => Promise<boolean>;
const guards = new Set<Guard>();
let pending: Promise<boolean> | null = null;
export function registerLeaveGuard(guard: Guard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}
export function mayLeave(): Promise<boolean> {
  if (pending) return pending;
  if (!guards.size) return Promise.resolve(true);
  pending = (async () => {
    for (const guard of guards) if (!(await guard())) return false;
    return true;
  })().finally(() => { pending = null; });
  return pending;
}
