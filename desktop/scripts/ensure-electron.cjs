const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const electronDir = require("path").dirname(require.resolve("electron/package.json"));
const { version } = require(join(electronDir, "package.json"));
const pathFile = join(electronDir, "path.txt");
const relPath = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
const binaryPath = join(electronDir, "dist", relPath);

function isReady() {
  return existsSync(pathFile) && existsSync(join(electronDir, "dist", readFileSync(pathFile, "utf8").trim()));
}

if (isReady()) process.exit(0);

const install = spawnSync(process.execPath, [join(electronDir, "install.js")], {
  stdio: "inherit",
  env: process.env,
});
if (install.status !== 0 && install.status !== null) {
  process.exit(install.status);
}
if (isReady()) process.exit(0);

const zipName = `electron-v${version}-${process.platform}-${process.arch}.zip`;
const zipPath = join(homedir(), "Library/Caches/electron", zipName);
if (!existsSync(zipPath)) {
  console.error(`Electron no dejó path.txt y no se encontró ${zipPath}.`);
  process.exit(1);
}

const dist = join(electronDir, "dist");
mkdirSync(dist, { recursive: true });
const unzip = spawnSync("unzip", ["-qo", zipPath, "-d", dist], { stdio: "inherit" });
if (unzip.status !== 0) process.exit(unzip.status ?? 1);
writeFileSync(pathFile, relPath);
if (!existsSync(binaryPath)) {
  console.error("Falló la extracción de Electron.app.");
  process.exit(1);
}
