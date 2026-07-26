import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const hash = process.argv[2];
const c = createClient({ chain: testnetBradbury });
const trace = await c.debugTraceTransaction({ hash });

const data = trace?.return_data;
console.log("return_data length:", typeof data === "string" ? data.length : data);

if (typeof data === "string" && data.startsWith("0x")) {
  const buf = Buffer.from(data.slice(2), "hex");
  const text = buf.toString("latin1");

  // Anything that looks like a Python exception or a renderer complaint.
  const needles = [
    "JSONDecode", "Expecting value", "KeyError", "ValueError", "TypeError",
    "IndexError", "AttributeError", "Traceback", "Error", "error",
    "json", "score", "render", "404", "Not Found", "prompt", "timeout",
    "exceed", "limit", "status",
  ];
  console.log("\n--- needle hits ---");
  for (const n of needles) {
    let i = text.indexOf(n);
    let count = 0;
    while (i !== -1 && count < 3) {
      const ctx = text.slice(Math.max(0, i - 90), i + 130).replace(/[^\x20-\x7E]/g, "·");
      console.log(`[${n}] …${ctx}…`);
      i = text.indexOf(n, i + 1);
      count++;
    }
  }

  console.log("\n--- all printable runs >= 12 chars ---");
  const runs = [...new Set(text.match(/[\x20-\x7E]{12,}/g) ?? [])];
  for (const r of runs) console.log("  ", r.slice(0, 220));
}

console.log("\n--- other trace keys ---");
for (const [k, v] of Object.entries(trace ?? {})) {
  if (k === "return_data") continue;
  const s = JSON.stringify(v);
  console.log(`  ${k}: ${s && s.length > 400 ? s.slice(0, 400) + "…" : s}`);
}
