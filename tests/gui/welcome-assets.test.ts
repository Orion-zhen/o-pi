import { readFile, readdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { welcomeAssets } from "../../scripts/welcome/svg.ts";

it("欢迎页 SVG 生成的资产与运行时 JSON 一致", async () => {
	const source = new URL("../../assets/welcome/", import.meta.url);
	const output = new URL("../../src/gui/frontend/app/welcome/art/", import.meta.url);
	const [character, reveal] = await Promise.all([
		readFile(new URL("character.svg", source), "utf8"),
		readFile(new URL("reveal.svg", source), "utf8"),
	]);
	const files = welcomeAssets(character, reveal);
	expect([...files.keys()].sort()).toEqual((await readdir(output)).filter((name) => name.endsWith(".json")).sort());
	for (const [name, content] of files) expect(content, name).toBe(await readFile(new URL(name, output), "utf8"));
});
