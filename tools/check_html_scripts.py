#!/usr/bin/env python3
"""Enforce the served-asset split required by the site CSP, and valid UTF-8.

Executable inline scripts, <style> elements and inline event attributes are
blocked by the deployed Content-Security-Policy. This gate fails if any are
reintroduced, including the JSON-LD exception (which is data, not script).

It also validates that every served text source decodes as UTF-8 before the
HTML parser sees it. A Windows-1252 curly quote used to surface as a bare
UnicodeDecodeError traceback with a byte offset and no file name; now the
failure names the file, line and column, and says how to fix it.

Run it without an argument to scan every served page and source file.
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

SOURCE_SUFFIXES = {".html", ".css", ".js", ".mjs"}
SOURCE_DIRS = ("scripts", "styles", "tools", "tests")


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


def decode(path: Path) -> str:
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as error:
        line = raw.count(b"\n", 0, error.start) + 1
        column = error.start - raw.rfind(b"\n", 0, error.start)
        byte = raw[error.start]
        hint = ""
        if 0x80 <= byte <= 0x9F:
            hint = " (Windows-1252 punctuation: re-save the file as UTF-8)"
        raise ValueError(f"{path}:{line}:{column}: invalid UTF-8 byte 0x{byte:02x}{hint}") from None


def iter_sources() -> list[Path]:
    paths = [path for path in Path(".").glob("*.html")]
    paths += [path for path in Path(".").glob("*.css")]
    paths += [path for path in Path(".").glob("*.js")]
    for directory in SOURCE_DIRS:
        base = Path(directory)
        if base.is_dir():
            paths += [path for path in base.rglob("*") if path.is_file() and path.suffix in SOURCE_SUFFIXES]
    return sorted(set(paths))


def audit(path: Path, text: str) -> list[str]:
    parser = AssetAudit()
    parser.feed(text)
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
    if len(sys.argv) > 1:
        paths = [Path(sys.argv[1])]
    else:
        paths = iter_sources()

    problems: list[str] = []
    html_pages = 0

    for path in paths:
        try:
            text = decode(path)
        except ValueError as error:
            problems.append(str(error))
            continue
        if path.suffix == ".html":
            html_pages += 1
            problems.extend(audit(path, text))

    if problems:
        print("\n".join(problems), file=sys.stderr)
        print(
            f"{len(problems)} source problem(s) found; the deployed CSP will block inline assets, "
            "and non-UTF-8 files break the HTML audit.",
            file=sys.stderr,
        )
        return 1

    print(f"All {len(paths)} source file(s) are valid UTF-8; no inline assets in {html_pages} HTML page(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
