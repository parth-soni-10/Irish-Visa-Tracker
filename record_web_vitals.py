#!/usr/bin/env python3
"""
Record a mobile Core Web Vitals baseline for the live site.

Calls the PageSpeed Insights API (strategy=mobile) and keeps both halves of what
it returns, because they answer different questions:

  * lab  - Lighthouse metrics (LCP, CLS, TBT, FCP, Speed Index) for one run now
  * field - CrUX p75 values for real Chrome users over the last 28 days

Writes perf/<date>-<label>.json (the trimmed record) and a row in
perf/BASELINE.md, so a later run can be diffed against it.

Usage:
    python record_web_vitals.py                      # today's baseline
    PSI_API_KEY=... python record_web_vitals.py      # own quota, not the shared pool
    python record_web_vitals.py --label after-defer  # tag the run

Notes:
    Without an API key the request goes through Google's shared anonymous quota
    (project_number:583797351490), which is exhausted most days and resets at
    midnight Pacific. A key from the Cloud console only needs PageSpeed Insights
    API enabled; pass it as PSI_API_KEY or --api-key.

Exit codes: 0 recorded, 2 quota exhausted, 3 other API/transport error.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
DEFAULT_URL = 'https://irishvisaupdatetracker.pages.dev/'
OUT_DIR = Path(__file__).resolve().parent / 'perf'

LAB = [
    ('first-contentful-paint', 'FCP'),
    ('largest-contentful-paint', 'LCP'),
    ('total-blocking-time', 'TBT'),
    ('cumulative-layout-shift', 'CLS'),
    ('speed-index', 'SI'),
    ('server-response-time', 'TTFB'),
    ('total-byte-weight', 'bytes'),
    ('bootup-time', 'bootup'),
]
FIELD = [
    ('LARGEST_CONTENTFUL_PAINT_MS', 'LCP'),
    ('CUMULATIVE_LAYOUT_SHIFT_SCORE', 'CLS'),
    ('INTERACTION_TO_NEXT_PAINT', 'INP'),
    ('FIRST_CONTENTFUL_PAINT_MS', 'FCP'),
]

QUOTA_HELP = """
Quota exhausted for the shared anonymous PageSpeed quota.
  * It resets at midnight Pacific (08:00 UTC in winter, 07:00 UTC in summer).
  * The reliable fix is your own key: enable "PageSpeed Insights API" in a Google
    Cloud project, then re-run with PSI_API_KEY=<key> python record_web_vitals.py
  * Until then no baseline is written - a baseline is a measurement, not a guess.
"""


def next_pacific_reset():
    try:
        from datetime import timedelta
        from zoneinfo import ZoneInfo

        now = datetime.now(ZoneInfo('America/Los_Angeles'))
        reset = (now + timedelta(days=1)).replace(hour=0, minute=5, second=0, microsecond=0)
        return reset.astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    except Exception:
        return 'midnight Pacific (08:00 UTC in winter, 07:00 UTC in summer)'


def fetch(url, strategy, api_key):
    params = {'url': url, 'strategy': strategy, 'category': 'performance'}
    if api_key:
        params['key'] = api_key
    request = urllib.request.Request(
        API + '?' + urllib.parse.urlencode(params),
        headers={'User-Agent': 'irish-visa-tracker-vitals/1.0'},
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', 'replace')
        detail = ''
        try:
            detail = json.loads(body)['error']['message']
        except Exception:
            detail = body[:300]
        if exc.code == 429:
            print(QUOTA_HELP.format(reset=next_pacific_reset()), file=sys.stderr)
            print('Next reset: %s' % next_pacific_reset(), file=sys.stderr)
            print('API said: %s' % detail, file=sys.stderr)
            sys.exit(2)
        print('PSI error %s: %s' % (exc.code, detail), file=sys.stderr)
        sys.exit(3)
    except (urllib.error.URLError, TimeoutError) as exc:
        print('Could not reach PSI: %s' % exc, file=sys.stderr)
        sys.exit(3)


def audit_number(audits, key):
    audit = audits.get(key) or {}
    return audit.get('numericValue')


def extract(payload, url, strategy):
    lr = payload.get('lighthouseResult') or {}
    audits = lr.get('audits') or {}
    categories = lr.get('categories') or {}

    lab = {'score': (categories.get('performance') or {}).get('score')}
    for key, label in LAB:
        lab[label] = audit_number(audits, key)

    def crUX(block):
        block = block or {}
        metrics = {}
        for key, label in FIELD:
            entry = (block.get('metrics') or {}).get(key) or {}
            metrics[label] = {'p75': entry.get('percentile'), 'category': entry.get('category')}
        return {'overall': block.get('overall_category'), 'metrics': metrics}

    return {
        'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'fetch_time': payload.get('fetchTime'),
        'url': url,
        'strategy': strategy,
        'lighthouse_version': (lr.get('lighthouseVersion')),
        'form_factor': (lr.get('configSettings') or {}).get('formFactor'),
        'lab': lab,
        'field': crUX(payload.get('loadingExperience')),
        'origin_field': crUX(payload.get('originLoadingExperience')),
    }


def git_commit():
    try:
        return subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return None


def fmt(value, unit=''):
    if value is None:
        return '-'
    if isinstance(value, float):
        text = ('%.3f' % value) if value < 10 else '%.1f' % value
    else:
        text = str(value)
    return '%s%s' % (text, unit)


def write_markdown(record, path, previous):
    lab, field = record['lab'], record['field']['metrics']
    header = (
        '| Recorded (UTC) | Label | Commit | Perf | Lab LCP | Lab CLS | Lab TBT | Lab FCP | '
        'Field LCP p75 | Field CLS p75 | Field INP p75 |\n'
        '|---|---|---|---|---|---|---|---|---|---|---|\n'
    )
    row = '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' % (
        record['recorded_at'].replace('T', ' '),
        record.get('label', '-'),
        record.get('commit') or '-',
        fmt(lab.get('score')),
        fmt(lab.get('LCP'), ' ms'),
        fmt(lab.get('CLS')),
        fmt(lab.get('TBT'), ' ms'),
        fmt(lab.get('FCP'), ' ms'),
        fmt(field.get('LCP', {}).get('p75'), ' ms'),
        fmt(field.get('CLS', {}).get('p75')),
        fmt(field.get('INP', {}).get('p75'), ' ms'),
    )
    if not path.exists():
        path.write_text(
            '# Mobile Core Web Vitals baseline\n\n'
            'Recorded by `record_web_vitals.py` against the live site. Lab columns come from one\n'
            'Lighthouse run; field columns are CrUX p75 over the previous 28 days for real Chrome\n'
            'users, so they move slowly and lag a deploy by up to a month.\n\n' + header + row,
            encoding='utf-8',
        )
        return
    text = path.read_text(encoding='utf-8')
    path.write_text(text + row, encoding='utf-8')


def print_summary(record, previous):
    lab, field = record['lab'], record['field']
    print('Source   : %s' % record.get('source', 'psi'))
    print('URL      : %s (%s)' % (record['url'], record['strategy']))
    print('Commit   : %s' % (record.get('commit') or 'unknown'))
    print('Perf     : %s' % fmt(lab.get('score')))
    print('Lab      : LCP %s   CLS %s   TBT %s   FCP %s   SI %s' % (
        fmt(lab.get('LCP'), ' ms'), fmt(lab.get('CLS')), fmt(lab.get('TBT'), ' ms'),
        fmt(lab.get('FCP'), ' ms'), fmt(lab.get('SI'), ' ms')))
    print('Field p75: LCP %s   CLS %s   INP %s   (%s)' % (
        fmt(field['metrics'].get('LCP', {}).get('p75'), ' ms'),
        fmt(field['metrics'].get('CLS', {}).get('p75')),
        fmt(field['metrics'].get('INP', {}).get('p75'), ' ms'),
        field.get('overall') or 'no CrUX data'))
    if previous:
        print()
        print('vs %s (%s):' % (previous['recorded_at'].replace('T', ' '), previous.get('label', '-')))
        for key in ('LCP', 'CLS', 'TBT', 'FCP', 'SI'):
            old, new = previous['lab'].get(key), lab.get(key)
            if isinstance(old, (int, float)) and isinstance(new, (int, float)):
                print('  lab %-4s %s -> %s  (%+.1f)' % (key, fmt(old), fmt(new), new - old))
        for key in ('LCP', 'CLS', 'INP'):
            old = previous['field']['metrics'].get(key, {}).get('p75')
            new = field['metrics'].get(key, {}).get('p75')
            if isinstance(old, (int, float)) and isinstance(new, (int, float)):
                print('  field %-3s %s -> %s  (%+.1f)' % (key, fmt(old), fmt(new), new - old))


def main():
    parser = argparse.ArgumentParser(description='Record a mobile Core Web Vitals baseline.')
    parser.add_argument('--url', default=DEFAULT_URL)
    parser.add_argument('--strategy', default='mobile', choices=['mobile', 'desktop'])
    parser.add_argument('--label', default='baseline')
    parser.add_argument('--api-key', default=os.environ.get('PSI_API_KEY', ''))
    parser.add_argument('--lighthouse-json', type=Path, default=None,
                        help='record from a local Lighthouse JSON run instead of calling PSI')
    parser.add_argument('--out-dir', type=Path, default=OUT_DIR)
    args = parser.parse_args()

    if args.lighthouse_json:
        raw = json.loads(Path(args.lighthouse_json).read_text(encoding='utf-8'))
        payload = {'lighthouseResult': raw, 'fetchTime': raw.get('fetchTime')}
        tested_url = raw.get('finalDisplayedUrl') or args.url
        source = 'lighthouse-local'
    else:
        payload = fetch(args.url, args.strategy, args.api_key)
        tested_url = args.url
        source = 'psi'

    record = extract(payload, tested_url, args.strategy)
    record['source'] = source
    record['label'] = args.label
    record['commit'] = git_commit()

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = record['recorded_at'][:10]
    out_path = out_dir / ('%s-%s-%s.json' % (stamp, args.strategy, args.label))
    out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + '\n', encoding='utf-8')

    previous = None
    for candidate in sorted(out_dir.glob('*-%s-*.json' % args.strategy)):
        if candidate != out_path:
            try:
                previous = json.loads(candidate.read_text(encoding='utf-8'))
            except Exception:
                continue

    write_markdown(record, out_dir / 'BASELINE.md', previous)
    print_summary(record, previous)
    print()
    print('wrote %s' % out_path)


if __name__ == '__main__':
    main()
