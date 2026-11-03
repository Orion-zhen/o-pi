import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { decodeHeic } from "../../../src/harness/media/heic-decode.ts";

it("预览拒绝解码超出像素预算的图片，仍可切回主图", async () => {
	const bytes = await readFile(new URL("../../fixtures/heic/multiple.heic", import.meta.url));
	const clap = bytes.indexOf("clap");
	expect(clap).toBeGreaterThan(0);
	expect(bytes.readUInt32BE(clap + 4)).toBe(16);
	bytes.writeUInt32BE(8192, clap + 4);
	bytes.writeUInt32BE(8192, clap + 12);
	expect(await decodeHeic(bytes, 0)).toEqual({ error: "HEIC/HEIF image exceeds 64000000 pixels." });
	expect(await decodeHeic(bytes)).toMatchObject({ width: 64, height: 32, primaryIndex: 1 });
});
