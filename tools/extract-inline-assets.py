#!/usr/bin/env python3
"""Extract inline <style> and executable <script> blocks from served HTML.

The tracker started as a single-file dashboard. Keeping CSS and JavaScript in
separate served files lets the Pages CSP forbid inline script/style elements
without maintaining manual copies of the same code.

Usage:
    python tools/extract-inline-assets.py

JSON-LD is intentionally left inline: it is data, not executable script, and
search engines read it from the document.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STYLE_RE = re.compile(r"<style\b[^>]*>(.*?)</style>", re.IGNORECASE | re.DOTALL)
SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.IGNORECASE | re.DOTALL)
JS_TYPES = {"", "text/javascript", "application/javascript", "module", "text/ecmascript", "application/ecmascript"}
INDEX_NAMES = ["index-push", "i18n", "index-icons", "index", "index-seo", "index-sw"]


def attr_value(attrs: str, name: str) -> str:
    match = re.search(r"\b" + re.escape(name) + r"\s*=\s*[\"']([^\"']*)[\"']", attrs, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.strip() + "\n", encoding="utf-8", newline="\n")


def split_page(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    stem = path.stem
    styles = list(STYLE_RE.finditer(source))
    if styles:
        if stem == "index":
            css_name = "index.css"
            write(ROOT / "styles" / css_name, "\n\n".join(match.group(1) for match in styles))
        else:
            css_name = stem + ".css"
            write(ROOT / "styles" / css_name, "\n\n".join(match.group(1) for match in styles))

        first = True
        def replace_style(match: re.Match[str]) -> str:
            nonlocal first
            if first:
                first = False
                return f'<link rel="stylesheet" href="/styles/{css_name}">'
            return ""
        source = STYLE_RE.sub(replace_style, source)

    script_index = 0
    def replace_script(match: re.Match[str]) -> str:
        nonlocal script_index
        attrs, body = match.group(1), match.group(2)
        script_type = attr_value(attrs, "type").lower()
        if "src" in attrs.lower() or script_type not in JS_TYPES or not body.strip():
            return match.group(0)
        script_index += 1
        if stem == "index" and script_index <= len(INDEX_NAMES):
            name = INDEX_NAMES[script_index - 1]
        else:
            name = f"{stem}-{script_index}"
        write(ROOT / "scripts" / (name + ".js"), body)
        module = ' type="module"' if script_type == "module" else ""
        return f'<script src="/scripts/{name}.js"{module}></script>'

    source = SCRIPT_RE.sub(replace_script, source)
    path.write_text(source, encoding="utf-8", newline="")


def main() -> int:
    pages = sorted(ROOT.glob("*.html"))
    for page in pages:
        split_page(page)
        print("Extracted inline assets from", page.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
