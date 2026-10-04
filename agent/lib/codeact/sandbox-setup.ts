/**
 * Template setup for `execute_python`: a venv at `$HOME/.codeact-venv` with
 * the analysis stack. Prints `CODEACT_NO_PYTHON` (exit 0) on backends without
 * python3, such as the just-bash fallback, so invoice features keep working.
 */

export const PYTHON_PACKAGES = ["pandas>=2.2,<4", "matplotlib>=3.8,<4", "dill>=0.3.8,<1"];

export const BOOTSTRAP_SCRIPT = `
set -u
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y -q python3 python3-pip >/dev/null 2>&1 || true
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq >/dev/null 2>&1 && \\
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-venv >/dev/null 2>&1 || true
  fi
  PY="$(command -v python3 || true)"
fi
if [ -z "$PY" ]; then
  echo "CODEACT_NO_PYTHON"
  exit 0
fi
"$PY" -m venv "$HOME/.codeact-venv" || exit 11
"$HOME/.codeact-venv/bin/python" -m pip install --quiet --disable-pip-version-check \\
  ${PYTHON_PACKAGES.map((name) => `'${name}'`).join(" ")} || exit 12
# Warm the matplotlib font cache so the first analysis is not slow.
MPLBACKEND=Agg "$HOME/.codeact-venv/bin/python" -c "import pandas, dill, matplotlib.pyplot as plt; plt.figure()" || exit 13
echo "CODEACT_READY"
`;
