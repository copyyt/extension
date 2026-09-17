import { spawnSync } from "node:child_process";

const target = process.env.VITE_APP_TYPE || "extension";
if (target !== "extension") process.exit(0);

const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

function run(command, args, env) {
  const result = spawnSync(command, args, {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(yarnCommand, ["vite", "build"], {
  ...process.env,
  VITE_APP_TYPE: "extension",
  VITE_EXTENSION_BUILD: "worker",
});
run(process.execPath, ["scripts/validate-extension-build.mjs"], process.env);
