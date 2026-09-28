#!/usr/bin/env node
// Fails when changesets/<version>.md is missing for package.json's current version.
// Usage: node scripts/check-changeset.mjs
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const relative = `changesets/${version}.md`;

if (existsSync(join(root, relative))) {
  console.log(`ok       ${name} ${version}`);
} else {
  console.error(`MISSING  ${name} ${version}  (expected: ${relative} - run: make changeset TYPE=Patch)`);
  process.exit(1);
}
