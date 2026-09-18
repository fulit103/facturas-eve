import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../src/desktop-bridge";

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke("desktop:getState"),
  login: (payload) => ipcRenderer.invoke("desktop:login", payload),
  logout: () => ipcRenderer.invoke("desktop:logout"),
  requestCameraAccess: () => ipcRenderer.invoke("desktop:requestCamera"),
};

contextBridge.exposeInMainWorld("facturasDesktop", bridge);
