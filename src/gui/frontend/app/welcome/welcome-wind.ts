export type WindLayer = "hair" | "left-sleeve" | "right-sleeve";
export const windDuration = 6;
const windStrength = 1.8;
export const windStep = 0.125;

function smooth(from: number, to: number, value: number) {
	const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
	return t * t * (3 - 2 * t);
}

// 一阵风只有一次小回摆，末端精确归零，不做持续的正弦摇摆。
function breeze(time: number) {
	if (time <= 0 || time >= 5.3) return 0;
	if (time > 4.1) return -0.08 * Math.sin(Math.PI * smooth(4.1, 5.3, time));
	const envelope = smooth(0, 1.15, time) * (1 - smooth(2.25, 4.1, time));
	return envelope * (0.9 + 0.1 * Math.cos((time - 1.2) * Math.PI * 1.25));
}

type Lock = {
	root: [number, number]; tip: [number, number];
	bend: number; curl: number; delay: number;
	weight: (x: number, y: number) => number;
};

// 各发束使用自己的轴线。中段与末段分别弯曲，不再横向平移整片轮廓。
const locks = ([
	{ root: [632, 178], tip: [550, 302], bend: -0.12, curl: -0.68, delay: 0.06,
		weight: (x, y) => (1 - smooth(620, 665, x)) * smooth(150, 225, y) * (1 - smooth(310, 355, y)) },
	{ root: [630, 274], tip: [671, 359], bend: -0.1, curl: -0.5, delay: 0.16,
		weight: (x, y) => (1 - smooth(650, 710, x)) * smooth(270, 330, y) },
	{ root: [825, 158], tip: [935, 174], bend: -0.1, curl: 0.65, delay: 0.14,
		weight: (x, y) => smooth(805, 870, x) * (1 - smooth(190, 230, y)) },
	{ root: [860, 205], tip: [847, 312], bend: -0.18, curl: -0.58, delay: 0.28,
		weight: (x, y) => smooth(795, 840, x) * smooth(180, 235, y) },
	{ root: [723, 155], tip: [776, 258], bend: -0.08, curl: -0.4, delay: 0.18,
		weight: (x, y) => smooth(675, 720, x) * (1 - smooth(805, 845, x)) * smooth(145, 205, y) * (1 - smooth(265, 300, y)) },
	{ root: [695, 95], tip: [762, 49], bend: 0.12, curl: 0.24, delay: 0,
		weight: (_x, y) => 1 - smooth(60, 73, y) },
] satisfies Lock[]).map((lock) => {
	const dx = lock.tip[0] - lock.root[0], dy = lock.tip[1] - lock.root[1];
	const length = Math.hypot(dx, dy);
	return { ...lock, length, ux: dx / length, uy: dy / length };
});

function arc(length: number, angle: number, distance: number): [number, number, number] {
	if (angle === 0) return [distance, 0, 0];
	const turn = angle * distance / length;
	const radius = length / angle;
	return [radius * Math.sin(turn), radius * (1 - Math.cos(turn)), turn];
}

function bend(lock: typeof locks[number], x: number, y: number, middle: number, end: number): [number, number] {
	if (middle === 0 && end === 0) return [0, 0];
	const dx = x - lock.root[0], dy = y - lock.root[1];
	const along = dx * lock.ux + dy * lock.uy;
	if (along <= 0) return [0, 0];
	const across = -dx * lock.uy + dy * lock.ux;
	const joint = lock.length * 0.56;
	let [a, b, angle] = arc(joint, middle, Math.min(along, joint));
	if (along > joint) {
		const [u, v, turn] = arc(lock.length - joint, end, Math.min(along, lock.length) - joint);
		a += u * Math.cos(angle) - v * Math.sin(angle);
		b += u * Math.sin(angle) + v * Math.cos(angle);
		angle += turn;
	}
	const rest = Math.max(0, along - lock.length);
	// 沿弧长推进，截面随切线旋转，保留发束宽度而非把尖角拉长。
	a += rest * Math.cos(angle) - across * Math.sin(angle) - along;
	b += rest * Math.sin(angle) + across * Math.cos(angle) - across;
	return [a * lock.ux - b * lock.uy, a * lock.uy + b * lock.ux];
}

function hairPoint(x: number, y: number, time: number, strength: number): [number, number] {
	let dx = 0, dy = 0, total = 0;
	for (const lock of locks) {
		const weight = lock.weight(x, y);
		if (weight === 0) continue;
		const middle = breeze(time - lock.delay);
		const tip = breeze(time - lock.delay - 0.26);
		// 末端晚到，并有小幅反向跟随，让原来的卷尖展开后再卷回。
		const curl = tip * (1 + 0.12 * Math.sin((time - lock.delay) * 4)) - middle * 0.22;
		const [u, v] = bend(lock, x, y, lock.bend * middle * strength, lock.curl * curl * strength);
		dx += u * weight;
		dy += v * weight;
		total += weight;
	}
	// 鬓角和肩颈的描线接点固定，发束交界处混合位移。
	const attached = smooth(8, 55, Math.hypot(x - 674, y - 273))
		* smooth(12, 65, Math.hypot(x - 687, y - 302))
		* smooth(12, 65, Math.hypot(x - 710, y - 374));
	const weight = attached / Math.max(1, total);
	return [x + dx * weight, y + dy * weight];
}

function windPoint(layer: WindLayer, x: number, y: number, time: number, strength: number): [number, number] {
	if (layer === "hair") return hairPoint(x, y, time, strength);
	// 只吹动袖子外缘，肩部、手腕附近的轮廓不动。衣料比发梢更早落定。
	const outer = layer === "left-sleeve" ? 1 - smooth(520, 655, x) : smooth(900, 965, x);
	const hem = smooth(465, 650, y);
	const delay = (layer === "left-sleeve" ? 0.4 : 0.6) + 0.12 * hem;
	const amount = outer * hem * breeze((time - delay) * 1.18) * strength;
	return [x + (layer === "left-sleeve" ? 34 : 40) * amount, y - 24 * amount];
}

export function windFrame(d: string, layer: WindLayer, time: number): string {
	if (time === 0 || time === windDuration) return d;
	// 输入已在构建时规范化为绝对 M/L/C/Z 和显式坐标对。
	return d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, rawX: string, rawY: string) => {
		const [x, y] = windPoint(layer, Number(rawX), Number(rawY), time, windStrength);
		return `${Number(x.toFixed(2))} ${Number(y.toFixed(2))}`;
	});
}

