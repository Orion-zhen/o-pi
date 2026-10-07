import { writeFile } from "node:fs/promises";
import { interpolate, toPathString } from "flubber";
import { breathingShapes } from "../src/gui/ui/transcript/breathing-shapes.ts";

// 采样和配对只在离线生成时执行，运行时由 Motion 插值同结构的折线路径。
const segments = breathingShapes.slice(1).map((to, index) => {
	const mix = interpolate(breathingShapes[index], to, { maxSegmentLength: 0.5, string: false });
	return [0, 1].map((position) => toPathString(mix(position).map((point) => point.map((value) => Number(value.toFixed(3))))));
});
await writeFile(new URL("../src/gui/ui/transcript/breathing-segments.ts", import.meta.url),
	"// 由 bun scripts/generate-breathing.mjs 生成，不手动修改。\n"
	+ "export const breathingSegments: [string, string][] = [\n"
	+ segments.map((pair) => `\t${JSON.stringify(pair)},`).join("\n") + "\n];\n");
