// Copies package.json "version" into the Cargo manifest and lockfiles.
// The Tauri config reads package.json itself.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`package.json version must be semver, got ${JSON.stringify(version)}.`);
  process.exit(1);
}

function writeIfChanged(file, next) {
  const full = path.join(root, file);
  const current = readFileSync(full, "utf8");
  if (current === next) {
    return;
  }
  writeFileSync(full, next);
  console.log(`Updated ${file} to ${version}`);
}

const cargoToml = path.join(root, "src-tauri/Cargo.toml");
const cargoText = readFileSync(cargoToml, "utf8");
const cargoNext = cargoText.replace(/^version = "[^"]+"/m, `version = "${version}"`);
if (cargoNext === cargoText && !cargoText.includes(`version = "${version}"`)) {
  console.error("Could not find the package version in src-tauri/Cargo.toml.");
  process.exit(1);
}
writeIfChanged("src-tauri/Cargo.toml", cargoNext);

const cargoLock = path.join(root, "src-tauri/Cargo.lock");
const lockText = readFileSync(cargoLock, "utf8");
const cargoLockVersion = /(name = "memose"\r?\nversion = )"[^"]+"/;
const lockNext = lockText.replace(cargoLockVersion, `$1"${version}"`);
if (!cargoLockVersion.test(lockNext)) {
  console.error("Could not find the memose package in src-tauri/Cargo.lock.");
  process.exit(1);
}
writeIfChanged("src-tauri/Cargo.lock", lockNext);

const packageLock = path.join(root, "package-lock.json");
const packageLockText = readFileSync(packageLock, "utf8");
const rootVersion = /^(\{\r?\n  "name": "memose",\r?\n  "version": )"[^"]+"/;
const workspaceVersion = /("": \{\r?\n      "name": "memose",\r?\n      "version": )"[^"]+"/;
let packageLockNext = packageLockText.replace(rootVersion, `$1"${version}"`);
packageLockNext = packageLockNext.replace(workspaceVersion, `$1"${version}"`);
if (!rootVersion.test(packageLockNext)) {
  console.error("Could not find the root version in package-lock.json.");
  process.exit(1);
}
if (!workspaceVersion.test(packageLockNext)) {
  console.error("Could not find the workspace version in package-lock.json.");
  process.exit(1);
}
writeIfChanged("package-lock.json", packageLockNext);
