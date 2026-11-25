import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { commandFeature, DiagnosticFailure, unknownDiagnostic, withFeature, type Feature } from "./diagnostics";

/** Bridge failures have no trustworthy diagnostic evidence in the UI. Only the host classifies. */
export async function invoke<T>(command: string, ...args: [args?: InvokeArgs, options?: InvokeOptions]): Promise<T> {
  try { return await tauriInvoke<T>(command, ...args); }
  catch (error) { throw new DiagnosticFailure(unknownDiagnostic(error, commandFeature(command)), error); }
}

/** Explicit feature for commands whose name prefix does not match what the user is doing. */
export async function invokeFor<T>(feature: Feature, command: string, ...args: [args?: InvokeArgs, options?: InvokeOptions]): Promise<T> {
  try { return await tauriInvoke<T>(command, ...args); }
  catch (error) { throw new DiagnosticFailure(withFeature(error, feature), error); }
}
