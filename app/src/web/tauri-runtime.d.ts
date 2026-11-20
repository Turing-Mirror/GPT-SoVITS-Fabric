declare global {
  interface Window {
    __TAURI_INTERNALS__?: Record<string, unknown>;
    __FABRIC_LAN_WEB__?: boolean;
  }
}
export {};
