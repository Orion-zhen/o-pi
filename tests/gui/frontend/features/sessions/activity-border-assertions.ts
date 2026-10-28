import { expect, type Locator } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export async function expectActivityTrail(border: Locator) {
	await expect(border).toHaveCSS("animation-play-state", "running");
	const orbit = await border.evaluate(async (element) => {
		const animation = element.getAnimations().find((item) => item instanceof CSSAnimation && item.animationName === "activity-orbit");
		const track = element.querySelector("rect");
		if (!animation?.effect || !track) throw new Error("缺少边框路径或动画");
		animation.pause();
		await animation.ready;
		const offsets = [0, 1000, 2000, 3000, 4000, 5000].map((time) => {
			animation.currentTime = time;
			return parseFloat(getComputedStyle(track).strokeDashoffset);
		});
		animation.currentTime = 1500;
		// 顺时针移动四分之一圈，沿顶部依次采样前端、中段和尾端。
		const points = [0.245, 0.16, 0.07].map((fraction) => {
			const point = track.getPointAtLength(track.getTotalLength() * fraction);
			return { x: point.x, y: point.y };
		});
		return { duration: animation.effect.getTiming().duration, pathLength: track.pathLength.baseVal, offsets, points };
	});
	try {
		expect(orbit.duration).toBe(6000);
		expect(orbit.pathLength).toBe(100);
		orbit.offsets.forEach((offset, index) => expect(offset).toBeCloseTo(-index * 100 / 6, 2));
		const image = await loadImage(await border.screenshot({ scale: "css" }));
		const canvas = createCanvas(image.width, image.height);
		const context = canvas.getContext("2d");
		context.drawImage(image, 0, 0);
		const background = Buffer.from(context.getImageData(10, 5, 1, 1).data);
		const contrast = orbit.points.map(({ x, y }) => {
			const pixel = context.getImageData(Math.round(x), Math.round(y), 1, 1).data;
			return pixel.slice(0, 3).reduce((sum, channel, index) => sum + Math.abs(channel - background.readUInt8(index)), 0);
		});
		const [head, middle, tail] = contrast;
		if (head === undefined || middle === undefined || tail === undefined) throw new Error("缺少渐变采样点");
		expect(head, "前端应比中段更深").toBeGreaterThan(middle);
		expect(middle, "中段应比尾端更深").toBeGreaterThan(tail);
		expect(head, "前端应有可见的强调色").toBeGreaterThan(20);
	} finally {
		await border.evaluate((element) => {
			element.getAnimations().find((item) => item instanceof CSSAnimation && item.animationName === "activity-orbit")?.play();
		});
	}
}
