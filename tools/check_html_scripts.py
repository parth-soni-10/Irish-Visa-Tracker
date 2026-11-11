#!/usr/bin/env python3
"""Syntax-check every inline JavaScript block in an HTML file.

The dashboard is a large single-page document with several inline script
blocks. A stray brace or quote in one of them is valid HTML, so it only breaks
in the browser after deployment. This check extracts the JavaScript blocks and
runs each through Node's parser.

Usage:
    python tools/check_html_scripts.py [index.html]
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from html.parser import HTMLParser
from pathlib import Path

JAVASCRIPT_TYPES = {
    "",
    "application/ecmascript",
    "application/javascript",
    "module",
    "text/ecmascript",
    "text/javascript",
}


class ScriptExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.scripts: list[dict[str, object]] = []
        self._current: dict[str, object] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        self._current = {
            "attrs": {name.lower(): value for name, value in attrs},
            "body": [],
            "line": self.getpos()[0],
        }

    def handle_data(self, data: str) -> None:
        if self._current is not None:
            self._current["body"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "script" or self._current is None:
            return
        body = "".join(self._current["body"])
        self.scripts.append(
            {
                "attrs": self._current["attrs"],
                "body": body,
                "line": self._current["line"],
            }
        )
        self._current = None


def is_javascript(attrs: dict[str, str | None]) -> bool:
    if "src" in attrs:
        return False
    script_type = (attrs.get("type") or "").strip().lower()
    return script_type in JAVASCRIPT_TYPES


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "index.html")
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as error:
        print(f"Could not read {path}: {error}", file=sys.stderr)
        return 2

    extractor = ScriptExtractor()
    extractor.feed(source)
    extractor.close()

    scripts = [script for script in extractor.scripts if is_javascript(script["attrs"])]
    if not scripts:
        print(f"No inline JavaScript blocks found in {path}.", file=sys.stderr)
        return 1

    failures = 0
    with tempfile.TemporaryDirectory(prefix="inline-script-check-") as tmp:
        for index, script in enumerate(scripts, start=1):
            body = str(script["body"])
            attrs = script["attrs"]
            is_module = (attrs.get("type") or "").strip().lower() == "module"
            suffix = ".mjs" if is_module else ".js"
            temp_path = Path(tmp) / f"inline-{index}{suffix}"
            temp_path.write_text(body, encoding="utf-8", newline="\n")

            try:
                result = subprocess.run(
                    ["node", "--check", str(temp_path)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
            except FileNotFoundError:
                print("node was not found on PATH.", file=sys.stderr)
                return 2

            if result.returncode == 0:
                continue

            failures += 1
            error_text = (result.stderr or result.stdout).strip()
            first_line = error_text.splitlines()[0] if error_text else "syntax error"
            location = re.search(r":(\d+)(?::\d+)?$", first_line)
            body_start = int(script["line"]) + 1
            if location:
                html_line = body_start + int(location.group(1)) - 1
                print(f"{path}:{html_line}: syntax error in inline script {index}")
            else:
                print(f"{path}: syntax error in inline script {index}")
            print(error_text)

    if failures:
        print(f"{failures} inline JavaScript block(s) failed syntax checking.", file=sys.stderr)
        return 1

    print(f"Checked {len(scripts)} inline JavaScript block(s) in {path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
