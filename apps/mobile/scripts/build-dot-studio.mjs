// Builds assets/dot-studio.html from assets/dot-avatar-maker.html.
//
// Why: the studio page loads three.js from a CDN. Inside the app that meant
// every avatar waited on a download, and none drew at all without a
// connection. This writes a copy of the page with three.js built into it, so
// the app draws avatars from what is already on the phone.
//
// Run after editing the studio page:  pnpm --filter mobile build:dot-studio
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "assets/dot-avatar-maker.html"), "utf8");

const importMap = /<script type="importmap">[\s\S]*?<\/script>\s*/;
const moduleOpen = '<script type="module">';
const start = source.indexOf(moduleOpen);
const end = source.lastIndexOf("</script>");
if (!importMap.test(source) || start < 0 || end < start) {
  throw new Error("The studio page no longer has the import map and module script this build expects.");
}

const bundled = await build({
  stdin: { contents: source.slice(start + moduleOpen.length, end), resolveDir: root, loader: "js" },
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2020",
  legalComments: "none",
  write: false,
});
const code = bundled.outputFiles[0].text;
if (code.includes("</script")) {
  throw new Error("The bundled script would end its own <script> tag.");
}

const page =
  source.slice(0, start).replace(importMap, "") + moduleOpen + "\n" + code + source.slice(end);
writeFileSync(join(root, "assets/dot-studio.html"), page);
console.log(`assets/dot-studio.html  ${(page.length / 1024).toFixed(0)} KB`);
