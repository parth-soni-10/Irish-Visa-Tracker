import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import router from "../functions/_router.js";

const ROOT = new URL("../", import.meta.url);
const TRACKING_URL = "https://visa.vfsglobal.com/ind/en/irl/track-application";
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function read(name) {
  return readFile(new URL(name, ROOT), "utf8");
}

test("the VFS handoff page uses one native GET form", async () => {
  const html = await read("vfs-tracking.html");
  const form = html.match(/<form[^>]*id="vfs-track-form"[^>]*>/)?.[0] || "";

  assert.match(form, new RegExp(`action="${TRACKING_URL}"`));
  assert.match(form, /method="get"/);
  assert.match(form, /target="_blank"/);
  assert.doesNotMatch(form, /novalidate/);
  assert.match(html, /id="vfs-reference"[^>]*required/);
  assert.match(html, /id="vfs-last-name"[^>]*required/);
  assert.doesNotMatch(html, /scripts\/vfs-tracking\.js/);
});

test("the VFS form target is allowed by the CSP in both delivery paths", async () => {
  const headers = await read("_headers");
  const router = await read("functions/_router.js");

  assert.match(headers, /form-action 'self' https:\/\/visa\.vfsglobal\.com;/);
  assert.match(router, /"form-action 'self' https:\/\/visa\.vfsglobal\.com; "/);
});

test("the VFS page is routed and copied into the deployment", async () => {
  const page = await read("vfs-tracking.html");
  const env = {
    ASSETS: {
      async fetch() {
        return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    },
  };
  const response = await router.fetch(new Request("https://tracker.test/vfs-tracking"), env, ctx);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="vfs-track-form"/);
  assert.match(response.headers.get("Content-Security-Policy"), /form-action 'self' https:\/\/visa\.vfsglobal\.com/);

  const deploy = await read("tools/deploy-pages.mjs");
  assert.match(deploy, /'vfs-tracking\.html'/);
});

test("the homepage Help anchor points at the existing track section", async () => {
  const [index, help] = await Promise.all([read("index.html"), read("help.html")]);

  assert.match(index, /href="\/help#track"/);
  assert.match(help, /<section id="track">/);
});
