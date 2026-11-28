import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOfficialFeed, buildJsonFeed, buildRssFeed } from '../functions/official-feed.js';
import { NDVO_SOURCE_PAGE } from '../functions/_report-sources.js';

const reports = {
  offices: {
    'new-delhi': [
      {
        report_date: '2026-11-16',
        fetched_at: '2026-11-17T13:44:49.663Z',
        decisions: 43152,
        approved: 36393,
        refused: 6759,
        source_file: 'https://www.ireland.ie/example?a=1&b=2',
        checksum: 'abc123',
        added: 103,
        removed: 1,
        changed: [{ number: '83289482', from: 'Refused', to: 'Approved' }]
      },
      {
        report_date: '2026-11-15',
        fetched_at: '2026-11-16T04:00:00.000Z',
        decisions: 42988,
        approved: 36252,
        refused: 6736,
        source_file: 'https://www.ireland.ie/example2'
      }
    ],
    beijing: [
      {
        report_date: '2026-11-01',
        decisions: 100,
        source_file: 'https://www.ireland.ie/beijing'
      }
    ]
  }
};

const manifest = {
  offices: [{ slug: 'new-delhi', name: 'New Delhi' }, { slug: 'beijing', name: 'Beijing' }]
};

test('feed is one item per official report, newest first, with no applicant rows', () => {
  const feed = buildOfficialFeed(reports, { manifest, baseUrl: 'https://tracker.test/' });
  assert.equal(feed.base_url, 'https://tracker.test');
  assert.equal(feed.entries.length, 3);
  assert.deepEqual(feed.entries.map((entry) => entry.report_date), ['2026-11-16', '2026-11-15', '2026-11-01']);
  assert.equal(feed.entries[0].office_name, 'New Delhi');
  assert.equal(feed.entries[0].decisions, 43152);
  assert.equal(feed.entries[0].corrections, 1);
  assert.equal(feed.entries[0].added, 103);
  assert.equal(JSON.stringify(feed).includes('83289482'), false, 'the feed must not expose row-level applicant numbers');
});

test('feed redirects a retired New Delhi file to the live official page', () => {
  const feed = buildOfficialFeed({
    offices: {
      'new-delhi': [
        {
          report_date: '2026-11-10',
          decisions: 100,
          source_file: 'https://www.ireland.ie/5308/20261110_NDVO_Visa_Decisions.ods'
        },
        {
          report_date: '2026-11-26',
          decisions: 200,
          source_file: 'https://www.ireland.ie/5384/20261126_NDVO_Visa_Decisions.ods'
        }
      ]
    }
  }, { manifest });
  const oldEntry = feed.entries.find((entry) => entry.report_date === '2026-11-10');
  assert.equal(oldEntry.source_file, NDVO_SOURCE_PAGE);
  assert.equal(feed.entries.find((entry) => entry.report_date === '2026-11-26').source_file,
    'https://www.ireland.ie/5384/20261126_NDVO_Visa_Decisions.ods');
});

test('JSON Feed 1.1 carries the official source and report facts', () => {
  const json = buildJsonFeed(buildOfficialFeed(reports, { manifest, baseUrl: 'https://tracker.test' }));
  assert.equal(json.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(json.feed_url, 'https://tracker.test/official-file-feed.json');
  assert.equal(json.items[0].url, 'https://www.ireland.ie/example?a=1&b=2');
  assert.equal(json.items[0]._official_file.checksum, 'abc123');
  assert.match(json.items[0].title, /New Delhi: 43,152 decisions/);
  assert.match(json.items[0].content_text, /Official file: https:\/\/www\.ireland\.ie\/example\?a=1&b=2/);
  assert.equal(json.items[0].date_published, "2026-11-16T00:00:00.000Z", "pubDate is the report's date, not the observation time");
  assert.equal(json.items[0]._observed_at, "2026-11-17T13:44:49.663Z");
  assert.match(json.items[0].content_text, /Observed by tracker: 2026-11-17T13:44:49\.663Z/);
});

test('RSS escapes XML and uses a stable guid', () => {
  const xml = buildRssFeed(buildOfficialFeed(reports, { manifest, baseUrl: 'https://tracker.test' }));
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<atom:link href="https:\/\/tracker\.test\/feed\.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(xml, /example\?a=1&amp;b=2/);
  assert.match(xml, /<guid isPermaLink="false">new-delhi:2026-11-16:abc123<\/guid>/);
  assert.match(xml, /<pubDate>Mon, 16 Nov 2026 00:00:00 GMT<\/pubDate>/);
  assert.doesNotMatch(xml, /<pubDate>Tue, 17 Nov 2026 13:44:49 GMT<\/pubDate>/);
  assert.match(xml, /Observed by tracker: 2026-11-17T13:44:49\.663Z/);
  assert.doesNotMatch(xml, /83289482/);
});
