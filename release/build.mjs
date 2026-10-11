// Builds installable release binaries for this computer and copies them into
// release/<platform>/ so they can be committed and published from git.
// A Mac builds macOS targets that are installed. Windows builds Windows targets.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");

const bundles = {
  darwin: { folder: "macos", marker: "-apple-darwin", extensions: [".dmg"] },
  win32: { folder: "windows", marker: "-pc-windows-", extensions: [".exe", ".msi"] },
  linux: { folder: "linux", marker: "-linux-", extensions: [".deb", ".rpm", ".AppImage"] },
};

function nodeVersionOk(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 20 || (major === 20 && minor >= 19);
}

function newestNvmNode() {
  const dir = path.join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(dir)) {
    return null;
  }
  const bins = readdirSync(dir)
    .filter((name) => nodeVersionOk(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const name = bins.at(-1);
  if (!name) {
    return null;
  }
  const bin = path.join(dir, name, "bin", "node");
  return existsSync(bin) ? bin : null;
}

if (!nodeVersionOk(process.versions.node)) {
  if (process.env.MEMOSE_RELEASE_NODE) {
    console.error(`Node ${process.version} is too old. Install Node 20.19 or newer.`);
    process.exit(1);
  }
  const bin = newestNvmNode();
  if (!bin) {
    console.error(`Node ${process.version} is too old. Install Node 20.19 or newer.`);
    process.exit(1);
  }
  const result = spawnSync(bin, [scriptPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      MEMOSE_RELEASE_NODE: "1",
      PATH: `${path.dirname(bin)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  process.exit(result.status ?? 1);
}

const cargoBin = path.join(homedir(), ".cargo", "bin");
if (existsSync(cargoBin)) {
  process.env.PATH = `${cargoBin}${path.delimiter}${process.env.PATH}`;
}

const family = bundles[platform()];
if (!family) {
  console.error(`No release bundles are defined for ${platform()}.`);
  process.exit(1);
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} failed`);
  }
  return result.stdout;
}

function hostTriple() {
  const host = commandOutput("rustc", ["-vV"]).match(/^host: (.+)$/m)?.[1]?.trim();
  if (!host) {
    throw new Error("could not read the rustc host");
  }
  return host;
}

function targetsForThisMachine() {
  const host = hostTriple();
  let installed = [];
  try {
    installed = commandOutput("rustup", ["target", "list", "--installed"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(family.marker));
  } catch {
    installed = [];
  }
  if (!installed.includes(host)) {
    installed.unshift(host);
  }
  return installed;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: platform() === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function bundleDir(triple) {
  return path.join(root, "src-tauri", "target", triple, "release", "bundle");
}

function findApps(dir, found = []) {
  if (!existsSync(dir)) {
    return found;
  }
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name.endsWith(".app") && statSync(full).isDirectory()) {
      found.push(full);
      continue;
    }
    if (statSync(full).isDirectory()) {
      findApps(full, found);
    }
  }
  return found;
}

function collectFiles(dir, extensions, found = []) {
  if (!existsSync(dir)) {
    return found;
  }
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      collectFiles(full, extensions, found);
      continue;
    }
    if (extensions.some((extension) => name.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}

const dest = path.join(root, "release", family.folder);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const targets = targetsForThisMachine();
const copied = [];
for (const triple of targets) {
  console.log(`\nBuilding ${triple}`);
  run("npm", ["run", "tauri", "build", "--", "--target", triple]);
  const files = collectFiles(bundleDir(triple), family.extensions);
  if (files.length === 0 && platform() === "darwin") {
    const apps = findApps(path.join(bundleDir(triple), "macos"));
    for (const app of apps) {
      const zip = path.join(dest, `${path.basename(app, ".app")}.zip`);
      run("ditto", ["-c", "-k", "--keepParent", app, zip]);
      copied.push(zip);
    }
  }
  for (const file of files) {
    const target = path.join(dest, path.basename(file));
    await cp(file, target);
    copied.push(target);
  }
}

if (copied.length === 0) {
  console.error(`The build finished without an installer in ${path.relative(root, dest)}.`);
  process.exit(1);
}

console.log("\nRelease files ready to commit:");
for (const file of copied) {
  console.log(`  ${path.relative(root, file)}`);
}
