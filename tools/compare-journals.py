#!/usr/bin/env python3
"""Compare workflow-run journals by event kind and field sequence.

`kit workflows run` journals every event to `<workdir>/run.jsonl` with a
`t` (ms since run start) and, for timed events, an `ms` duration. Both are
wall-clock, so two runs of the same deterministic probe differ on them and
only on them. This tool drops exactly those two fields and compares what is
left, which makes "the plane's behaviour did not change" a checkable claim
rather than a reading of the output.

Usage:
    python3 tools/compare-journals.py BEFORE_DIR AFTER_DIR [--probes a,b]

Each directory holds one or more `<timestamp>-<slug>/run.jsonl` run
directories. A before-run matches the after-run whose directory name ends
with the same `<slug>`. Exit 0 on identical sequences, 1 on any difference,
2 on a usage or missing-file problem.

What counts as a difference: everything except what a run generates for
itself. The plan that commissioned this tool named `t` and `ms`; the journal
turned out to carry four kinds of per-run noise —
  * `t` (offset since run start) and `durationMs` (a duration, on run-done),
  * the command handle's random suffix, e.g. `command-v6t7f4`,
  * the OS `pid`,
and the last two appear twice: once as the `service` event's own fields and
again inside the probe's report text, because the probe quotes the handle and
pid back (`started command-v6t7f4 (pid 88562)`). So the ids are collapsed by
pattern wherever they appear, not by field name, and the two timing keys are
dropped. Everything else — event kinds, field names, field order, field
counts, values, and the sequence itself — is compared exactly.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# Run directories are named `<YYYY-MM-DD_HH-MM-SS>-<slug>`; the timestamp
# itself contains dashes, so the prefix is matched rather than split on.
RUN_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-")

# Per-run values that carry no behaviour, so a difference in them is not a
# regression. See the module docstring for how this set was established.
TIME_KEYS = ("t", "ms", "durationMs")
GENERATED_ID_KEYS = ("handle", "pid")
HANDLE_RE = re.compile(r"command-[0-9a-z]{4,}")
PID_RE = re.compile(r"pid \d+")


def slug_of(dirname):
    """`2026-10-05_18-29-23-checkpoint-probe` -> `checkpoint-probe`."""
    return RUN_PREFIX.sub("", dirname)


def collapse_generated(value):
    """Erase a run's own generated ids wherever they appear, at any depth."""
    if isinstance(value, str):
        return PID_RE.sub("pid <pid>", HANDLE_RE.sub("command-<id>", value))
    if isinstance(value, list):
        return [collapse_generated(v) for v in value]
    if isinstance(value, dict):
        return {k: collapse_generated(v) for k, v in value.items()}
    return value


def strip_timing(value):
    """Drop the timing and generated-id keys, leaving structure intact."""
    if isinstance(value, dict):
        return {k: strip_timing(v) for k, v in value.items() if k not in TIME_KEYS and k not in GENERATED_ID_KEYS}
    if isinstance(value, list):
        return [strip_timing(v) for v in value]
    return value


def load_journal(path):
    """Parse a journal, failing loudly on a line that is not an event."""
    events = []
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{lineno}: not a JSON event: {exc}")
            events.append(strip_timing(collapse_generated(raw)))
    return events


def index_runs(root):
    """Map slug -> journal path for every run directory under `root`."""
    runs = {}
    for entry in sorted(os.listdir(root)):
        path = os.path.join(root, entry)
        if os.path.isdir(path) and os.path.exists(os.path.join(path, "run.jsonl")):
            runs[slug_of(entry)] = os.path.join(path, "run.jsonl")
    return runs


def describe(events):
    """A one-line shape of the sequence: kinds in order, in run dir terms."""
    return " ".join(str(e.get("kind", "?")) for e in events)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("before", help="directory of baseline run directories")
    ap.add_argument("after", help="directory of the run directories to compare")
    ap.add_argument("--probes", help="comma-separated slugs to restrict the comparison to")
    args = ap.parse_args()

    for root in (args.before, args.after):
        if not os.path.isdir(root):
            raise SystemExit(f"not a directory: {root}")

    before = index_runs(args.before)
    after = index_runs(args.after)
    wanted = [s.strip() for s in args.probes.split(",") if s.strip()] if args.probes else sorted(before)

    missing = [s for s in wanted if s not in before]
    if missing:
        raise SystemExit(f"no baseline run for: {', '.join(missing)}")
    missing = [s for s in wanted if s not in after]
    if missing:
        raise SystemExit(f"no comparison run for: {', '.join(missing)}")

    failures = 0
    for slug in wanted:
        b_events = load_journal(before[slug])
        a_events = load_journal(after[slug])
        if b_events == a_events:
            print(f"  {slug}: identical — {len(b_events)} events")
            continue

        failures += 1
        print(f"  {slug}: DIFFERS — {len(b_events)} baseline events, {len(a_events)} after")
        if describe(b_events) != describe(a_events):
            print(f"      kind sequence changed:")
            print(f"        before: {describe(b_events)}")
            print(f"        after:  {describe(a_events)}")
        for i, (b, a) in enumerate(zip(b_events, a_events)):
            if b == a:
                continue
            print(f"      first differing event #{i}: kind={b.get('kind')!r}")
            for key in sorted(set(b) | set(a)):
                if b.get(key) != a.get(key):
                    bv, av = b.get(key, "<absent>"), a.get(key, "<absent>")
                    print(f"        {key}:")
                    print(f"          before: {json.dumps(bv, sort_keys=True)[:400]}")
                    print(f"          after:  {json.dumps(av, sort_keys=True)[:400]}")
            break
        else:
            extra = "baseline" if len(b_events) > len(a_events) else "after"
            print(f"      the {extra} sequence has events the other does not")

    if failures:
        print(f"compare-journals: {failures} run(s) differ")
        return 1
    print(f"compare-journals: {len(wanted)} run(s) identical (t/ms stripped)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
