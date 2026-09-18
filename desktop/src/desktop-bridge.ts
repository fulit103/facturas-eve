export interface DesktopState {
  readonly host: string;
  readonly loggedIn: boolean;
  readonly proxyOrigin: string;
  readonly username: string;
}

export interface DesktopLoginPayload {
  readonly host: string;
  readonly password: string;
  readonly username: string;
}

export interface DesktopBridge {
  getState: () => Promise<DesktopState>;
  login: (payload: DesktopLoginPayload) => Promise<{ ok: true }>;
  logout: () => Promise<{ ok: true }>;
  requestCameraAccess: () => Promise<{ ok: true }>;
}

declare global {
  interface Window {
    readonly facturasDesktop?: DesktopBridge;
  }
}
