import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";
import { welcomeCharacter, welcomeReveal } from "./svg.ts";

export function welcomeSvg(): Plugin {
	const character = normalizePath(fileURLToPath(new URL("../../assets/welcome/character.svg", import.meta.url)));
	const reveal = normalizePath(fileURLToPath(new URL("../../assets/welcome/reveal.svg", import.meta.url)));
	return {
		name: "welcome-svg",
		enforce: "pre",
		async load(id) {
			const compile = id === `${character}?welcome` ? welcomeCharacter : id === `${reveal}?welcome` ? welcomeReveal : undefined;
			if (!compile) return;
			const file = id.slice(0, -"?welcome".length);
			this.addWatchFile(file);
			return { code: `export default ${JSON.stringify(compile(await readFile(file, "utf8")))};`, map: null };
		},
	};
}
