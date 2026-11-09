// Run the installable bundle through the pinned app's actual moejs runtime.
// The upstream checkout is disposable and lives only under this project's cache.
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "1af0d8efd77fdf630c27cfc635f12e9cb089ce10";
const cache = join(root, ".cache", "runtime");
const checkout = join(cache, "mygo-music");
const source = process.env.MYGO_MUSIC_SOURCE || "https://github.com/egoist/mygo-music.git";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

await access(join(root, "index.js")).catch(() => {
  throw new Error("Build the installable plugin first: vp build");
});
const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
for (const artifact of [
  join("dist", "mygo-music-yoi", "plugin.json"),
  join("dist", `mygo-music-yoi-${manifest.version}.zip`),
]) {
  await access(join(root, artifact)).catch(() => {
    throw new Error(`Missing ${artifact}; create installation artifacts first: vp run package`);
  });
}
await mkdir(cache, { recursive: true });
try {
  await access(join(checkout, ".git"));
} catch {
  run("git", ["clone", "--no-checkout", source, checkout]);
  run("git", ["-C", checkout, "checkout", "--detach", commit]);
  await writeFile(join(cache, "owned-checkout"), commit + "\n");
}
const marker = await readFile(join(cache, "owned-checkout"), "utf8").catch(() => "");
if (marker.trim() !== commit)
  throw new Error("Refusing to modify an unrecognized runtime checkout");
const head = spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
if (head.status !== 0 || head.stdout.trim() !== commit)
  throw new Error("Runtime checkout does not match the pinned upstream commit");
await copyFile(
  join(root, "tests", "runtime", "yoi_test.go"),
  join(checkout, "internal", "plugin", "yoi_test.go"),
);
console.log(`Testing YOI in MyGo Music 0.1.22 (${commit.slice(0, 12)})`);
if (process.env.YOI_GITHUB_REPO) {
  console.log(`Also checking anonymous client installation from ${process.env.YOI_GITHUB_REPO}`);
}
run("go", ["test", "./internal/plugin", "-run", "^TestYOI", "-count=1", "-v"], {
  cwd: checkout,
  env: { ...process.env, YOI_PLUGIN_DIR: root },
});
