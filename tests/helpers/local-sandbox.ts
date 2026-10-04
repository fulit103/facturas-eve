import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import type { CodeSandbox } from "#lib/codeact/executor.js";

/**
 * A `CodeSandbox` backed by the local filesystem and a real `python3`, so the
 * runner and its RPC bridge are exercised end to end in tests. Paths are used
 * as-is; tests pass a temporary `home`.
 */
export function createLocalSandbox(): CodeSandbox & { spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    async writeTextFile({ path, content }) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    async readBinaryFile({ path }) {
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return null;
      }
    },
    async spawn({ command, env }) {
      spawned.push(command);
      const child = spawn("bash", ["-c", command], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exit = new Promise<{ exitCode: number }>((resolve) => {
        child.on("close", (code, signal) => resolve({ exitCode: code ?? (signal ? 137 : 1) }));
      });
      return {
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exit,
        async kill() {
          child.kill("SIGKILL");
        },
      };
    },
  };
}

/** True when the local python3 can import the libraries the runner needs. */
export function hasPythonDataStack(): boolean {
  try {
    execFileSync("python3", ["-c", "import pandas, matplotlib"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
