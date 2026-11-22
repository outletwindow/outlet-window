import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "src");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ["index.html", "app.js", "catalog.js", "styles.css"]) {
  await cp(resolve(source, file), resolve(output, file));
}
console.log("Customer web prototype built into apps/customer-web/dist");
