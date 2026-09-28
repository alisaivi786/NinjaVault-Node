#!/usr/bin/env node
// Installs the packed package into a throw-away project under the OS temp dir and checks that both the ESM
// (`import`) and CJS (`require`) entry points load and work against a stubbed fetch. No network calls to a
// CDN are made.
//
// Usage:
//   node scripts/smoke-test.mjs                  # runs `npm pack` first (needs dist/ - run `npm run build`)
//   node scripts/smoke-test.mjs path/to/pkg.tgz  # uses an existing tarball (CI: the uploaded artifact)
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const options = (cwd) => ({ cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const quote = (arg) => `"${arg.replaceAll('"', '\\"')}"`;
// npm is a .cmd shim on Windows, so it runs through the shell as one quoted command line.
const npm = (args, cwd) => execSync(`npm ${args.map(quote).join(" ")}`, options(cwd));
const node = (args, cwd) => execFileSync(process.execPath, args, options(cwd));

const work = mkdtempSync(join(tmpdir(), "ninjavault-cdn-smoke-"));
try {
  let tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
  if (tarball === undefined) {
    npm(["pack", "--silent", "--pack-destination", work], root);
    const packed = readdirSync(work).find((file) => file.endsWith(".tgz"));
    if (packed === undefined) {
      throw new Error("npm pack produced no tarball.");
    }
    tarball = join(work, packed);
  }

  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "smoke", private: true, version: "0.0.0" }),
  );
  npm(["install", "--no-audit", "--no-fund", "--silent", tarball], app);

  const body = (load) => `
${load}
const json = (data) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
const fetch = async (url, init) => {
  if (init.headers["X-Api-Key"] !== "cdn_xxxxx") throw new Error("missing API key header");
  if (url.endsWith("/api/v1/buckets")) return json([{ name: "documents", visibility: "Private", fileCount: 1, totalSizeBytes: 7 }]);
  if (init.method === "POST") {
    const file = init.body.get("File");
    if (file.name !== "a.txt" || file.type !== "text/plain" || (await file.text()) !== "payload") throw new Error("bad multipart");
    return json({ id: "1", bucket: "documents", objectKey: "k/a.txt", originalFileName: "a.txt", contentType: "text/plain", sizeBytes: 7, visibility: "Private", url: "u" });
  }
  return new Response("file-bytes", { headers: { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename*=UTF-8''a.txt" } });
};
const cdn = new NinjaVaultCdnClient({ baseUrl: "https://cdn.example.com", apiKey: "cdn_xxxxx", fetch });
const url = cdn.buildPublicUrl("public assets", "logos/logo one.png");
if (url !== "https://cdn.example.com/public/public%20assets/logos/logo%20one.png") throw new Error("bad url " + url);
if (!(new CdnApiError("x", { statusCode: 400 }) instanceof Error)) throw new Error("CdnApiError is not an Error");
(async () => {
  const buckets = await cdn.listBuckets();
  if (buckets[0].name !== "documents") throw new Error("listBuckets failed");
  const uploaded = await cdn.upload({ bucket: "documents", tenantId: 1, file: new TextEncoder().encode("payload"), fileName: "a.txt", contentType: "text/plain" });
  if (uploaded.objectKey !== "k/a.txt") throw new Error("upload failed");
  const download = await cdn.download("documents", "k/a.txt");
  if (download.fileName !== "a.txt" || (await download.text()) !== "file-bytes") throw new Error("download failed");
  console.log(KIND + " ok: " + url + " (v" + SDK_VERSION + ", node " + process.version + ")");
})().catch((error) => { console.error(error); process.exit(1); });
`;
  writeFileSync(
    join(app, "esm.mjs"),
    body(
      'import { NinjaVaultCdnClient, CdnApiError, SDK_VERSION } from "@ninjavault/cdn";\nconst KIND = "ESM";',
    ),
  );
  writeFileSync(
    join(app, "cjs.cjs"),
    body(
      'const { NinjaVaultCdnClient, CdnApiError, SDK_VERSION } = require("@ninjavault/cdn");\nconst KIND = "CJS";',
    ),
  );

  process.stdout.write(node(["esm.mjs"], app));
  process.stdout.write(node(["cjs.cjs"], app));
  console.log(`Smoke test passed (${tarball}).`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
