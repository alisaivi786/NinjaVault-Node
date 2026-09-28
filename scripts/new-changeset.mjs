#!/usr/bin/env node
// Creates changesets/<version>.md from changesets/_template.md for package.json's current version.
// Usage: node scripts/new-changeset.mjs [Patch|Minor|Major]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const type = process.argv[2] ?? "Patch";
if (!["Patch", "Minor", "Major"].includes(type)) {
  console.error(`Unknown change type "${type}". Use Patch, Minor or Major.`);
  process.exit(1);
}
const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(root, "changesets", `${version}.md`);
if (existsSync(target)) {
  console.error(
    `changesets/${version}.md already exists - bump "version" in package.json first (npm version patch --no-git-tag-version).`,
  );
  process.exit(1);
}
const date = new Date().toISOString().slice(0, 10);
const content = readFileSync(join(root, "changesets", "_template.md"), "utf8")
  .replaceAll("{{PackageId}}", name)
  .replaceAll("{{Version}}", version)
  .replaceAll("{{Date}}", date)
  .replaceAll("{{Type}}", type);
writeFileSync(target, content);
console.log(`Created changesets/${version}.md - fill in Changes / Why / Breaking Changes.`);
