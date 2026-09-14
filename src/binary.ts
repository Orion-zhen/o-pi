import path from "node:path";
import { id, assets } from "opi:assets";
import { extractAssets } from "./runtime/extract-assets.js";

const resourceDir = extractAssets(id, assets);
process.env.PI_OPI_RESOURCE_DIR = resourceDir;
process.env.PI_PACKAGE_DIR = path.join(resourceDir, "pi");

if (process.argv[2] === "--opi-discord-daemon") {
	process.argv.splice(2, 1);
	await import("./discord-presence/coordinator-daemon.js");
} else {
	await import("./cli.js");
}
