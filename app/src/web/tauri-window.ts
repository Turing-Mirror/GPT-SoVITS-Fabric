/** No-op window facade for the browser build. */
type WindowFacade = {
  label: string;
  close: () => Promise<void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  startDragging: () => Promise<void>;
  show: () => Promise<void>;
  setFocus: () => Promise<void>;
  onCloseRequested: (_fn: (event: { preventDefault: () => void }) => void | Promise<void>) => Promise<() => void>;
};

const facade: WindowFacade = {
  label: "main",
  close: async () => {},
  minimize: async () => {},
  toggleMaximize: async () => {},
  isMaximized: async () => false,
  startDragging: async () => {},
  show: async () => {},
  setFocus: async () => {},
  onCloseRequested: async () => () => {},
};

export function getCurrentWindow(): WindowFacade { return facade; }
export async function getAllWindows(): Promise<WindowFacade[]> { return [facade]; }
export class WebviewWindow {
  static getByLabel(_label: string): WindowFacade | null { return facade; }
}
