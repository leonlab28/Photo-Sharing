// Copies the browser libraries from node_modules into public/vendor so the
// site never depends on a third-party CDN at runtime. Run: npm run vendor
import { copyFileSync, mkdirSync } from "node:fs";

const files = [
  ["node_modules/exifr/dist/full.esm.mjs", "public/vendor/exifr.mjs"],
  ["node_modules/client-zip/index.js", "public/vendor/client-zip.js"],
  ["node_modules/heic-to/dist/heic-to.js", "public/vendor/heic-to.js"],
  ["node_modules/utif2/UTIF.js", "public/vendor/utif.js"],
  // Fonts are self-hosted: loading them from Google's servers is a GDPR problem in Germany.
  ["node_modules/@fontsource-variable/big-shoulders-display/files/big-shoulders-display-latin-wght-normal.woff2", "public/fonts/big-shoulders-display.woff2"],
  ["node_modules/@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2", "public/fonts/schibsted-grotesk.woff2"],
  ["node_modules/@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-ext-wght-normal.woff2", "public/fonts/schibsted-grotesk-ext.woff2"],
];

mkdirSync("public/vendor", { recursive: true });
mkdirSync("public/fonts", { recursive: true });
for (const [from, to] of files) {
  copyFileSync(from, to);
  console.log(`${from} -> ${to}`);
}
