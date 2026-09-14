import { execFileSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
rmSync(new URL("dist/", root), { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json"))), "-p", "tsconfig.build.json"], {
	cwd: fileURLToPath(root),
	stdio: "inherit",
});
chmodSync(new URL("dist/cli.js", root), 0o755);
