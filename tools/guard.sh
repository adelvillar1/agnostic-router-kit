#!/usr/bin/env bash
# The three guards that define a correct step of the plane split.
#
# Every step of the split is pure code motion, so a step is correct when the
# plane's journals are unchanged, both editions' doctor introduced no new
# problem, and the live router config is untouched. Run this before
# committing a step. All three must pass; a step that fails any of them is not
# ready, and the guard is not something to run at the end.
#
#   tools/guard.sh [--baseline DIR] [--step LABEL]
#
# `--baseline` is a directory of `<timestamp>-<slug>/run.jsonl` run
# directories captured with tools/compare-journals.py-compatible layout —
# i.e. AGNOSTIC_ROUTER_KIT_HOME pointing at it. It is machine-local by design:
# journals are per-run evidence, not source. Capture it once before the first
# step moves anything (see the plan's step 1).
set -uo pipefail

ENGINE_DIR="${ENGINE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
KIT_DIR="${KIT_DIR:-/Users/alejandrodelvillar/Projects/zcode-router-kit}"
BASELINE="${BASELINE:-/tmp/plane-baseline}"
STEP="step"
PROBES="checkpoint context commands"
# Must match the workdir the baseline was captured with: `run-start` echoes the
# workdir, so a different path is a difference the comparison is right to flag.
WORKDIR=/tmp/plane-check/wd

while [ $# -gt 0 ]; do
  case "$1" in
    --baseline) BASELINE="$2"; shift 2 ;;
    --step) STEP="$2"; shift 2 ;;
    *) echo "guard: unknown argument: $1" >&2; exit 2 ;;
  esac
done

fails=0
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

reset_workdir() {
  python3 - "$WORKDIR" <<'PY'
import os, shutil, sys
p = sys.argv[1]
if os.path.isdir(p):
    shutil.rmtree(p)
os.makedirs(p, exist_ok=True)
PY
}

# ── guard 1: the deterministic event sequence is unchanged ──────────────────
say "guard 1 — journal baseline ($STEP)"
if [ ! -d "$BASELINE/workflow-runs" ]; then
  echo "  SKIPPED: no baseline at $BASELINE/workflow-runs — capture it before the first step"
else
  home=$(mktemp -d "${TMPDIR:-/tmp}/plane-guard.XXXXXX")
  for p in $PROBES; do
    reset_workdir
    AGNOSTIC_ROUTER_KIT_HOME="$home" \
      node "$ENGINE_DIR/bin/agnostic-router-kit.mjs" workflows run "$p-probe" \
      --workdir "$WORKDIR" --grant workspace-io,process >/dev/null 2>&1 \
      || { echo "  FAIL: $p-probe did not run"; fails=$((fails+1)); }
  done
  python3 "$ENGINE_DIR/tools/compare-journals.py" "$BASELINE/workflow-runs" "$home/workflow-runs"
  [ $? -eq 0 ] || fails=$((fails+1))
fi

# ── guard 2: both editions' doctor introduced no new problem ────────────────
say "guard 2 — doctor, both editions ($STEP)"
engine_problems() {
  # The doctor's own verdict line is `✗ doctor: N problem(s): …`, and it also
  # starts with ✗, so counting `^✗` lines counts the verdict too. Read the
  # number the doctor reports; fall back to the check lines (`✗  ` — two
  # spaces) only if the verdict line is not there.
  local out n
  out=$(cd "$ENGINE_DIR" && npm run kit --silent -- doctor 2>&1)
  n=$(printf '%s\n' "$out" | sed -n 's/^.*doctor: \([0-9]*\) problem.*/\1/p' | head -1)
  if [ -n "$n" ]; then printf '%s' "$n"; else printf '%s' "$out" | grep -c '^✗  '; fi
}
kit_problems() {
  local out n
  out=$(cd "$KIT_DIR" && npm run kit --silent -- doctor 2>&1)
  n=$(printf '%s\n' "$out" | sed -n 's/^.*doctor: \([0-9]*\) problem.*/\1/p' | head -1)
  if [ -n "$n" ]; then printf '%s' "$n"; else printf '%s' "$out" | grep -c '^✗  '; fi
}
e=$(engine_problems); k=$(kit_problems)
echo "  engine edition: $e failing check(s)"
echo "  kit:            $k failing check(s)"
# The engine edition is the development checkout: it carries no .env, no
# provider keys and no installed service, so it is red on this machine before
# the split starts and is expected to stay exactly as red. What matters is that
# the count does not move — a new failure is this step's problem, not the
# machine's. The kit is the applied edition and must stay fully green.
if [ "$k" != "0" ]; then
  echo "  FAIL: the kit's doctor is not green"
  fails=$((fails+1))
fi
if [ -n "${ENGINE_BASELINE_PROBLEMS:-}" ] && [ "$e" != "$ENGINE_BASELINE_PROBLEMS" ]; then
  echo "  FAIL: the engine edition went from $ENGINE_BASELINE_PROBLEMS to $e failing checks"
  fails=$((fails+1))
else
  echo "  engine edition: ${ENGINE_BASELINE_PROBLEMS:-(uncounted)} -> $e (record ENGINE_BASELINE_PROBLEMS=$e)"
fi

# ── guard 3: the live router config is untouched ────────────────────────────
say "guard 3 — router config ($STEP)"
config="${HOME}/.zcode/router/config.json"
expected="d32a694cde0b25ce2ff91d91b7274c7766dceb1d340d6f9a0f9581b277672f07"
if [ -f "$config" ]; then
  actual=$(shasum -a 256 "$config" | cut -d' ' -f1)
  echo "  sha256: $actual"
  if [ "$actual" != "$expected" ]; then
    echo "  FAIL: expected $expected — the live config changed"
    fails=$((fails+1))
  else
    echo "  unchanged"
  fi
else
  echo "  FAIL: no router config at $config"
  fails=$((fails+1))
fi

# ── verdict ─────────────────────────────────────────────────────────────────
say "guard verdict ($STEP)"
if [ "$fails" -eq 0 ]; then
  echo "  all guards pass"
  exit 0
fi
echo "  $fails guard failure(s) — do not commit this step"
exit 1
