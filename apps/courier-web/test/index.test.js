import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("courier app HTML keeps metadata tags on separate valid lines", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  assert.match(html, /<meta name="description"[^>]*>\n\s*<meta name="outlet-window-api-base-url"/);
  assert.doesNotMatch(html, /\\\\n\s*<meta/);
});
