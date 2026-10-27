import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { expect, it } from "vitest";
import layers from "../../assets/welcome/character.svg?welcome";
import { offerPath } from "../../src/gui/frontend/app/welcome/welcome-offer.ts";

it("提取后的图层保持原 SVG 的轮廓、透明度和绘制顺序", async () => {
	const character = await readFile(new URL("../../assets/welcome/character.svg", import.meta.url), "utf8");
	const paths = layers.flatMap((layer) => layer.paints).map((paint) => `<path d="${paint.d}" fill-opacity="${paint.opacity}"/>`).join("");
	const compiled = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="420 24 680 730"><g fill="currentColor" color="#cbcbcf">${paths}</g></svg>`;
	const pixels = (svg: string) => new Resvg(svg, { fitTo: { mode: "width", value: 340 } }).render().pixels;
	expect(pixels(compiled)).toEqual(pixels(character));
});

it("运行时捧起双手，保留真实角色路径的拓扑", () => {
	for (const layer of layers) for (const paint of layer.paints) {
		const offered = offerPath(paint.d);
		expect(offered.match(/[MLCZ]/g)).toEqual(paint.d.match(/[MLCZ]/g));
		expect([...offered.matchAll(/-?\d+(?:\.\d+)?/g)]).toHaveLength([...paint.d.matchAll(/-?\d+(?:\.\d+)?/g)].length);
		expect(offered).not.toMatch(/NaN|Infinity/);
		if (layer.id === "left-hand" || layer.id === "right-hand") expect(offered).not.toBe(paint.d);
	}
});
