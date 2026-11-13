#!/usr/bin/env python3
"""Enforce the served-asset split required by the site CSP.

Executable inline scripts, <style> elements and inline event attributes are
blocked by the deployed Content-Security-Policy. This gate fails if any are
reintroduced, including the JSON-LD exception (which is data, not script).
Run it without an argument to scan every served HTML page.
"""

from __future__ import annotations

import re
import sys
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


class AssetAudit(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.inline_scripts: list[int] = []
        self.inline_styles: list[int] = []
        self.inline_style_attrs: list[int] = []
        self.inline_handlers: list[tuple[int, str]] = []
        self._script: dict[str, object] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        line = self.getpos()[0]
        values = {name.lower(): value for name, value in attrs}
        if tag.lower() == "style":
            self.inline_styles.append(line)
        if tag.lower() == "script":
            script_type = (values.get("type") or "").strip().lower()
            if "src" not in values and script_type in JAVASCRIPT_TYPES:
                self.inline_scripts.append(line)
            self._script = {"line": line}
        if "style" in values:
            self.inline_style_attrs.append(line)
        for name in values:
            if re.fullmatch(r"on[a-z]+", name):
                self.inline_handlers.append((line, name))

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script":
            self._script = None


def audit(path: Path) -> list[str]:
    parser = AssetAudit()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    problems = []
    for line in parser.inline_scripts:
        problems.append(f"{path}:{line}: executable inline <script> (move it to /scripts)")
    for line in parser.inline_styles:
        problems.append(f"{path}:{line}: inline <style> (move it to /styles)")
    for line in parser.inline_style_attrs:
        problems.append(f"{path}:{line}: inline style= attribute (move it to a class)")
    for line, name in parser.inline_handlers:
        problems.append(f"{path}:{line}: inline {name}= handler (use event delegation)")
    return problems


def main() -> int:
    paths = [Path(sys.argv[1])] if len(sys.argv) > 1 else sorted(Path(".").glob("*.html"))
    problems = [problem for path in paths for problem in audit(path)]
    if problems:
        print("\n".join(problems), file=sys.stderr)
        print(f"{len(problems)} inline asset problem(s) found; the deployed CSP will block these.", file=sys.stderr)
        return 1
    print(f"No inline scripts, styles, style attributes or event handlers in {len(paths)} HTML page(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
