import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session, systemPreferences } from "electron";
import {
  isDesktopMediaPermission,
  shouldAllowDesktopPermissionCheck,
} from "../../lib/desktop-media-permission";
import { clearCredentials, loadCredentials, saveCredentials } from "./credentials";
import { normalizeTargetOrigin, startEveProxy, type EveProxy } from "./proxy";

function preloadPath(): string {
  const dir = join(import.meta.dirname, "../preload");
  for (const name of ["index.cjs", "index.js", "index.mjs"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, "index.cjs");
}

const DEFAULT_EVE_HOST = "http://localhost:3000";

let mainWindow: BrowserWindow | null = null;
let proxy: EveProxy | null = null;

function defaultHost(): string {
  return normalizeTargetOrigin(process.env.FACTURAS_EVE_HOST ?? DEFAULT_EVE_HOST);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: "Facturas",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    return;
  }

  void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function registerIpc(): void {
  ipcMain.handle("desktop:getState", () => {
    const stored = loadCredentials();
    return {
      proxyOrigin: proxy?.origin ?? "",
      host: stored?.host ?? defaultHost(),
      loggedIn: stored !== null,
      username: stored?.username ?? "",
    };
  });

  ipcMain.handle(
    "desktop:login",
    (_event, payload: { host: string; username: string; password: string }) => {
      const host = normalizeTargetOrigin(payload.host);
      if (!/^https?:\/\//u.test(host)) {
        throw new Error("El host del agente debe ser una URL http o https.");
      }
      saveCredentials({
        host,
        username: payload.username.trim(),
        password: payload.password,
      });
      return { ok: true };
    },
  );

  ipcMain.handle("desktop:logout", () => {
    clearCredentials();
    return { ok: true };
  });

  ipcMain.handle("desktop:requestCamera", async () => {
    if (process.platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("camera");
      if (status === "denied") {
        throw new Error(
          "macOS bloqueó la cámara. Habilitála en Ajustes del Sistema → Privacidad → Cámara.",
        );
      }
      if (status !== "granted") {
        const granted = await systemPreferences.askForMediaAccess("camera");
        if (!granted) {
          throw new Error("Necesitamos permiso para usar la cámara.");
        }
      }
    }
    return { ok: true };
  });
}

function configureMediaPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isDesktopMediaPermission(permission));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return shouldAllowDesktopPermissionCheck(permission, requestingOrigin);
  });
}

app.whenReady().then(async () => {
  configureMediaPermissions();
  registerIpc();
  proxy = await startEveProxy({
    getTargetOrigin: () => loadCredentials()?.host ?? defaultHost(),
    getCredentials: () => {
      const stored = loadCredentials();
      if (stored === null || stored.username.length === 0) return null;
      return { username: stored.username, password: stored.password };
    },
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void proxy?.close();
});
