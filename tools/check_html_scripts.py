#!/usr/bin/env python3
"""Syntax-check every inline <script> block in an HTML file with `node --check`.

Usage:
    python tools/check_html_scripts.py [path/to/file.html]   # default: index.html

Extracts each inline script block (skipping <script src=...> and non-JS
types), writes it to a temp file, and runs `node --check` on it. Node reports
syntax errors against the temp file, so paths are rewritten back to the
original HTML file; a block's first line maps 1:1 to the HTML line the
<script> tag sits on (the tag is alone on its line), so line numbers stay
usable as-is.

Exit codes: 0 = all blocks clean, 1 = at least one syntax error,
2 = setup problem (no blocks found, or node missing).
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TARGET = ROOT / "index.html"
SCRIPT_RE = re.compile(r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script>",
                       re.DOTALL | re.IGNORECASE)
JS_TYPES = {"text/javascript", "application/javascript", "module"}


def extract_blocks(html):
    """Return [(start_line, type, body)] for every inline, JS-typed block."""
    blocks = []
    for m in SCRIPT_RE.finditer(html):
        attrs = m.group("attrs")
        if re.search(r"\bsrc\s*=", attrs, re.IGNORECASE):
            continue  # external script — nothing inline to check
        t = re.search(r"type\s*=\s*[\"']([^\"']+)[\"']", attrs, re.IGNORECASE)
        if t and t.group(1).strip().lower() not in JS_TYPES:
            continue  # JSON-LD or other non-executable payload
        start_line = html.count("\n", 0, m.start()) + 1
        blocks.append((start_line, (t.group(1).strip().lower() if t else None),
                       m.group("body")))
    return blocks


def main(argv):
    target = Path(argv[1]) if len(argv) > 1 else DEFAULT_TARGET
    if not target.is_file():
        print(f"error: {target} not found", file=sys.stderr)
        return 2
    if shutil.which("node") is None:
        print("error: node is not on PATH — cannot run node --check", file=sys.stderr)
        return 2

    html = target.read_text(encoding="utf-8")
    blocks = extract_blocks(html)
    if not blocks:
        print(f"error: no inline script blocks found in {target}", file=sys.stderr)
        return 2

    rel = target.name if target.parent == ROOT else str(target)
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, (start_line, stype, body) in enumerate(blocks):
            # "module" blocks must be checked as ESM (node treats .js as CJS).
            suffix = ".mjs" if stype == "module" else ".js"
            f = Path(tmp) / f"block_{i}{suffix}"
            f.write_text(body, encoding="utf-8")
            proc = subprocess.run(["node", "--check", str(f)],
                                  capture_output=True, text=True)
            if proc.returncode != 0:
                failures += 1
                msg = (proc.stderr or proc.stdout).strip()
                msg = msg.replace(str(f), f"{rel} (inline script starting line {start_line})")
                print(f"{rel}: inline script starting line {start_line} "
                      f"failed node --check:\n{msg}", file=sys.stderr)

    if failures:
        print(f"FAIL: {failures} of {len(blocks)} inline script block(s) "
              f"in {rel} have syntax errors", file=sys.stderr)
        return 1
    print(f"OK: {len(blocks)} inline script block(s) in {rel} pass node --check")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
