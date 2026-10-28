import { expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import character from "../../../../../assets/welcome/character.svg?welcome";
import { windDuration, type WindLayer } from "../../../../../src/gui/frontend/app/welcome/welcome-wind.ts";
import { createWindPath } from "../../../../../src/gui/frontend/app/welcome/welcome-wind-path.ts";

const layers: { id: WindLayer; paints: { d: string }[] }[] = character.flatMap(({ id, paints }) =>
	id === "hair" || id === "left-sleeve" || id === "right-sleeve" ? [{ id, paints }] : []);

it("吹风改变头发和衣袖，保留真实路径拓扑并在结束时归位", () => {
	for (const layer of layers) {
		const paths = layer.paints.map((paint) => ({ base: paint.d, sample: createWindPath(paint.d, layer.id) }));
		for (const time of [0, 0.0625, 0.15, 1.825, 4.62, windDuration]) {
			const frames = paths.map(({ base, sample }) => {
				const frame = sample(time, 1);
				expect(frame.match(/[MLCZ]/g)).toEqual(base.match(/[MLCZ]/g));
				expect(frame.match(/-?\d+(?:\.\d+)?/g)?.length).toBe(base.match(/-?\d+(?:\.\d+)?/g)?.length);
				expect(frame).not.toMatch(/NaN|Infinity/);
				if (time === 0 || time === windDuration) expect(frame).toBe(base);
				return frame;
			});
			if (time === 1.825) expect(frames).not.toEqual(layer.paints.map((paint) => paint.d));
		}
	}
});

it("吹风中断时逐步归位，下一次待机仍能正常播放", () => {
	for (const layer of layers) {
		const paths = layer.paints.map((paint) => createWindPath(paint.d, layer.id));
		const base = layer.paints.map((paint) => paint.d);
		const active = paths.map((sample) => sample(1.825, 1));
		const returning = paths.map((sample) => sample(1.825, 0.5));
		expect(returning).not.toEqual(active);
		expect(returning).not.toEqual(base);
		expect(paths.map((sample) => sample(1.825, 0))).toEqual(base);
		expect(paths.map((sample) => sample(0, 1))).toEqual(base);
		paths.forEach((sample) => sample(0.15, 1));
		expect(paths.map((sample) => sample(1.825, 1))).toEqual(active);
	}
});

it("脸颊、颈部和肩线的真实像素属于静态层，而非头发层", () => {
	const painted = (id: string, viewBox: string) => {
		const paths = character.filter((layer) => layer.id === id).flatMap((layer) => layer.paints)
			.map((paint) => `<path d="${paint.d}" fill-opacity="${paint.opacity}"/>`).join("");
		const pixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="264" height="150" preserveAspectRatio="none">${paths}</svg>`).render().pixels;
		return pixels.some((value, index) => index % 4 === 3 && value > 0);
	};
	for (const region of ["702 310 44 25", "704 336 16 17", "640 381 35 3"]) {
		expect(painted("hair", region), `hair: ${region}`).toBe(false);
		expect(painted("face-neck", region), `face-neck: ${region}`).toBe(true);
	}
});
