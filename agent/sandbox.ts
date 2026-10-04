import { defaultBackend, defineSandbox } from "eve/sandbox";

import { BOOTSTRAP_SCRIPT, PYTHON_PACKAGES } from "#lib/codeact/sandbox-setup.js";

/**
 * Sandbox for `execute_python`.
 *
 * - The template (built once, reused by every session) gets a Python venv with
 *   pandas, matplotlib, and dill at `$HOME/.codeact-venv`.
 * - Every session then runs with egress denied: generated code has no network
 *   and no credentials. Airtable is reached only through the host-side RPC
 *   bridge in `agent/lib/codeact/`.
 *
 * On Vercel the factory itself only allows PyPI, so even a sandbox replaced
 * without re-running `onSession` cannot reach anything else.
 */

export default defineSandbox({
  backend: defaultBackend({
    vercel: {
      networkPolicy: { allow: ["pypi.org", "files.pythonhosted.org"] },
    },
  }),
  revalidationKey: () => `codeact-python-v1:${PYTHON_PACKAGES.join(",")}`,
  async bootstrap({ use }) {
    const sandbox = await use();
    const result = await sandbox.run({ command: BOOTSTRAP_SCRIPT });
    if (result.stdout.includes("CODEACT_NO_PYTHON")) {
      // e.g. the just-bash fallback: invoices keep working, execute_python reports
      // that the analysis environment is unavailable.
      console.warn("[sandbox] python3 is not available; execute_python will be disabled.");
      return;
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Python setup for execute_python failed (exit ${result.exitCode}): ${
          result.stderr.slice(-2_000) || result.stdout.slice(-2_000)
        }`,
      );
    }
  },
  async onSession({ use }) {
    const sandbox = await use();
    try {
      await sandbox.setNetworkPolicy("deny-all");
    } catch (error) {
      // just-bash fixes its policy at creation and runs no real binaries.
      console.warn("[sandbox] could not apply deny-all network policy", error);
    }
  },
});
