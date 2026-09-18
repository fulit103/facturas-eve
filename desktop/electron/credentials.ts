import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";

export interface DesktopCredentials {
  readonly host: string;
  readonly username: string;
  readonly password: string;
}

const FILE_NAME = "credentials.bin";

function credentialsPath(): string {
  return join(app.getPath("userData"), FILE_NAME);
}

export function saveCredentials(credentials: DesktopCredentials): void {
  const payload = Buffer.from(JSON.stringify(credentials), "utf8");
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  const body = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(payload.toString("utf8")) : payload;
  writeFileSync(path, body);
}

export function loadCredentials(): DesktopCredentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString("utf8");
    const parsed = JSON.parse(json) as Partial<DesktopCredentials>;
    if (typeof parsed.host !== "string") return null;
    return {
      host: parsed.host,
      username: typeof parsed.username === "string" ? parsed.username : "",
      password: typeof parsed.password === "string" ? parsed.password : "",
    };
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  const path = credentialsPath();
  if (existsSync(path)) unlinkSync(path);
}
