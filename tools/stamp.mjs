// Cache-busting: stamps every local script URL with ?v=<version> so a browser
// never mixes a new page with old cached scripts. Run before each commit:
//   node tools/stamp.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const dir = new URL("../web/", import.meta.url);
const v = Date.now().toString(36);
const files = ["index.html", ...readdirSync(dir).filter((f) => f.endsWith(".js"))];
for (const f of files) {
  const p = new URL(f, dir), s = readFileSync(p, "utf8");
  // "./x.js", "x.js" in src=, new URL("./x.js", ...), import(...)
  const out = s.replace(/(["'])(\.\/)?([\w-]+\.js)(\?v=\w+)?\1/g, (m, q, dot, name, _old) =>
    files.includes(name) ? `${q}${dot ?? ""}${name}?v=${v}${q}` : m);
  if (out !== s) writeFileSync(p, out);
}
console.log("stamped", v);
