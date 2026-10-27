function smooth(from: number, to: number, value: number) {
	const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
	return t * t * (3 - 2 * t);
}

// 头部轻转、手臂上抬，袖口与手腕共享连续变形场。
function offerPoint(x: number, y: number): [number, number] {
	const left = x < 770;
	const arm = y > 580 ? 1 : left ? 1 - smooth(667, 714, x) : smooth(858, 906, x);
	const lift = smooth(415, 593, y) * arm;
	const head = (1 - smooth(325, 383, y)) * 0.013;
	const dx = x - 770, dy = y - 370;
	return [
		770 + dx * Math.cos(head) - dy * Math.sin(head) + (left ? -2 : 2) * lift,
		370 + dx * Math.sin(head) + dy * Math.cos(head) - 18 * lift,
	];
}

export function offerPath(d: string): string {
	// 输入已在构建时规范化为绝对 M/L/C/Z 和显式坐标对。
	return d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, rawX: string, rawY: string) =>
		offerPoint(Number(rawX), Number(rawY)).map((value) => Number(value.toFixed(2))).join(" "));
}
