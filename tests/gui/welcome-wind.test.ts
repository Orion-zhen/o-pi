import { expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import face from "../../src/gui/frontend/app/welcome/art/face-neck.json";
import hair from "../../src/gui/frontend/app/welcome/art/hair.json";
import leftSleeve from "../../src/gui/frontend/app/welcome/art/left-sleeve.json";
import rightSleeve from "../../src/gui/frontend/app/welcome/art/right-sleeve.json";
import { interpolate, mix } from "motion/react";
import { windDuration, windFrame, windPoint, windStep, windStrength, type WindLayer } from "../../src/gui/frontend/app/welcome/welcome-wind.ts";
import { createWindPath } from "../../src/gui/frontend/app/welcome/welcome-wind-path.ts";

const times = Array.from({ length: windDuration / windStep + 1 }, (_, index) => index * windStep);
const layers: { id: WindLayer; paints: { d: string }[] }[] = [
	{ id: "hair", paints: hair.paints },
	{ id: "left-sleeve", paints: leftSleeve.paints },
	{ id: "right-sleeve", paints: rightSleeve.paints },
];

it("风吹保留真实角色路径的拓扑，并精确回到原图", () => {
	for (const layer of layers) for (const paint of layer.paints) {
		const frames = times.map((time) => windFrame(paint.d, layer.id, time, 1.8));
		expect(frames[0]).toBe(paint.d);
		expect(frames.at(-1)).toBe(paint.d);
		const commands = paint.d.match(/[MLCZ]/g);
		const coordinates = [...paint.d.matchAll(/-?\d+(?:\.\d+)?/g)];
		for (const frame of frames) {
			expect(frame.match(/[MLCZ]/g)).toEqual(commands);
			expect(frame.match(/-?\d+(?:\.\d+)?/g)).toHaveLength(coordinates.length);
			expect(frame).not.toMatch(/NaN|Infinity/);
		}
	}
});

it("按 1.8 倍风力插值采样，中断时从当前轮廓归位", () => {
	expect(windStrength).toBe(1.8);
	for (const layer of layers) for (const paint of layer.paints) {
		const reference = interpolate(times, times.map((time) => windFrame(paint.d, layer.id, time, 1.8)));
		const sample = createWindPath(paint.d, layer.id);
		for (const time of [0, 0.0625, 0.15, 1.825, 4.62, 6, 0.2, 1.825]) {
			expect(sample(time, 1)).toBe(reference(time));
			for (const amount of [0.8, 0.3, 0]) expect(sample(time, amount)).toBe(amount === 0 ? paint.d : mix(paint.d, reference(time))(amount));
		}
	}
});

it("风吹时头顶、肩部和袖口固定，发梢与袖缘有位移", () => {
	for (const time of times) {
		expect(windPoint("hair", 730, 110, time, 1.8)).toEqual([730, 110]);
		expect(windPoint("hair", 760, 80, time, 1.8)).toEqual([760, 80]);
		expect(windPoint("hair", 800, 110, time, 1.8)).toEqual([800, 110]);
		expect(windPoint("left-sleeve", 610, 420, time, 1.8)).toEqual([610, 420]);
		expect(windPoint("left-sleeve", 655, 610, time, 1.8)).toEqual([655, 610]);
		expect(windPoint("right-sleeve", 895, 610, time, 1.8)).toEqual([895, 610]);
	}
	expect(windPoint("hair", 560, 290, 1.5, 1)[0]).toBeGreaterThan(570);
	expect(windPoint("right-sleeve", 980, 650, 1.8, 1)[0]).toBeGreaterThan(1014);
	expect(windPoint("right-sleeve", 980, 650, 1.8, 1)[1]).toBeLessThan(630);
});

it("两侧发梢和刘海改变朝向，而不是只平移或拉长", () => {
	const tips = [
		[[923, 177], [934, 170]], [[560, 302], [548, 299]],
		[[842, 302], [835, 313]], [[766, 253], [776, 258]],
	] as const;
	for (const [a, b] of tips) {
		const c = windPoint("hair", a[0], a[1], 1.8, 1);
		const d = windPoint("hair", b[0], b[1], 1.8, 1);
		const before = Math.atan2(b[1] - a[1], b[0] - a[0]);
		const after = Math.atan2(d[1] - c[1], d[0] - c[0]);
		const turn = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
		const stretch = Math.hypot(d[0] - c[0], d[1] - c[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
		expect(turn).toBeGreaterThan(0.2);
		expect(stretch).toBeGreaterThan(0.8);
		expect(stretch).toBeLessThan(1.2);
	}
});

it("脸颊、颈部和肩线的真实像素属于静态层，而非头发层", () => {
	const painted = (layer: { paints: { d: string; opacity: number }[] }, viewBox: string) => {
		const paths = layer.paints.map((paint) => `<path d="${paint.d}" fill-opacity="${paint.opacity}"/>`).join("");
		const pixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="264" height="150" preserveAspectRatio="none">${paths}</svg>`).render().pixels;
		return pixels.some((value, index) => index % 4 === 3 && value > 0);
	};
	for (const region of ["702 310 44 25", "704 336 16 17", "640 381 35 3"]) {
		expect(painted(hair, region), `hair: ${region}`).toBe(false);
		expect(painted(face, region), `face-neck: ${region}`).toBe(true);
	}
});

it("起止无位移，衣袖先于发梢落定", () => {
	for (const layer of layers) {
		expect(windPoint(layer.id, 940, 300, 0, 1)).toEqual([940, 300]);
		expect(windPoint(layer.id, 940, 300, windDuration, 1)).toEqual([940, 300]);
	}
	expect(windPoint("right-sleeve", 980, 650, 5.4, 1)).toEqual([980, 650]);
	expect(windPoint("hair", 940, 300, 5.2, 1)[0]).toBeLessThan(940);
});
