// Every element app.js looks up must exist in index.html. A missing one throws on
// the first press and the bot never talks (this happened when a switch was removed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("every $(id) used by app.js exists in index.html", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const used = new Set([...js.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]));
  const have = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !have.has(id));
  assert.deepEqual(missing, []);
  assert.ok(used.size > 20);
});
