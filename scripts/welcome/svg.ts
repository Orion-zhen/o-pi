import { DOMParser } from "linkedom";

const layerIds = ["hair", "face-neck", "collar", "body", "left-sleeve", "right-sleeve", "left-hand", "right-hand"];
const viewBox = "420 24 680 730";

function required(element: Element, name: string): string {
	const value = element.getAttribute(name);
	if (!value?.trim()) throw new Error(`${element.id || element.localName}: 缺少 ${name}`);
	return value;
}

function numberAttribute(element: Element, name: string, min: number, max = Infinity): number {
	const value = Number(required(element, name));
	if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${element.id}: ${name} 超出范围`);
	return value;
}

function svgGroup(source: string, kind: "character" | "reveal"): Element {
	const svg = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
	if (svg.localName !== "svg" || svg.getAttribute("viewBox") !== viewBox) throw new Error(`${kind}: viewBox 必须为 ${viewBox}`);
	const attributes: Record<string, readonly string[]> = {
		svg: ["xmlns", "viewBox"], title: [],
		g: kind === "character" ? ["id", "fill", "color"] : ["fill", "stroke", "stroke-linecap", "stroke-linejoin"],
		path: kind === "character" ? ["id", "d", "fill-opacity"] : ["id", "d", "stroke-width", "data-start", "data-duration"],
	};
	// 构建时只提取路径和显式属性，拒绝会被遗漏的变换、样式及其他 SVG 元素。
	for (const element of [svg, ...svg.querySelectorAll("*")]) {
		const allowed = attributes[element.localName];
		if (!allowed) throw new Error(`${kind}: 不支持 <${element.localName}>`);
		for (const attribute of element.attributes) {
			if (!allowed.includes(attribute.name)) throw new Error(`${kind}: 不支持 ${element.localName}[${attribute.name}]，请先展开变换和样式`);
		}
	}
	const children = [...svg.children].filter((element) => element.localName !== "title");
	const group = children[0];
	if (children.length !== 1 || group?.localName !== "g") throw new Error(`${kind}: 根节点必须包含一个绘制分组`);
	const expected = kind === "character"
		? { fill: "currentColor" }
		: { fill: "none", stroke: "white", "stroke-linecap": "round", "stroke-linejoin": "round" };
	for (const [name, value] of Object.entries(expected)) {
		if (group.getAttribute(name) !== value) throw new Error(`${kind}: 绘制分组必须设置 ${name}="${value}"`);
	}
	return group;
}

function pathData(path: Element): string {
	const d = required(path, "d");
	const tokenPattern = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
	const tokens = [...d.matchAll(tokenPattern)].map((match) => match[0]);
	if (d.replace(tokenPattern, "").replace(/[\s,]/g, "")) throw new Error(`${path.id}: 无效路径`);
	if (tokens[0] !== "M") throw new Error(`${path.id}: 路径必须从绝对 M 指令开始`);
	const base: string[] = [];
	for (let index = 0; index < tokens.length;) {
		const command = tokens[index++];
		const count = command === "M" || command === "L" ? 2 : command === "C" ? 6 : command === "Z" ? 0 : undefined;
		if (count === undefined) throw new Error(`${path.id}: 仅支持显式绝对 M/L/C/Z 指令，收到 ${command}`);
		const points = Array.from({ length: count / 2 }, (_, point) => [Number(tokens[index + point * 2]), Number(tokens[index + point * 2 + 1])] as const);
		if (points.some((point) => point.some((value) => !Number.isFinite(value)))) throw new Error(`${path.id}: ${command} 坐标不完整`);
		base.push(command + points.flat().join(" "));
		index += count;
	}
	return base.join(" ");
}

export function welcomeCharacter(character: string) {
	const layers = [...svgGroup(character, "character").children];
	if (layers.length !== layerIds.length || layers.some((layer, index) => layer.localName !== "g" || layer.id !== layerIds[index])) {
		throw new Error(`character: 图层顺序必须为 ${layerIds.join(", ")}`);
	}
	return layers.map((layer) => {
		if (layer.attributes.length !== 1) throw new Error(`${layer.id}: 图层只允许 id 属性，样式应写到路径上`);
		const paths = [...layer.children];
		if (!paths.length || paths.some((path) => path.localName !== "path" || path.children.length)) throw new Error(`${layer.id}: 图层必须直接包含路径`);
		const paints = paths.map((path) => ({ d: pathData(path), opacity: numberAttribute(path, "fill-opacity", 0, 1) }));
		return { id: layer.id, paints };
	});
}

export function welcomeReveal(reveal: string) {
	const paths = [...svgGroup(reveal, "reveal").children];
	if (!paths.length || paths.some((path) => path.localName !== "path" || path.children.length)) throw new Error("reveal: 绘制分组必须直接包含路径");
	return paths.map((path) => ({
		d: required(path, "d"),
		start: numberAttribute(path, "data-start", 0),
		duration: numberAttribute(path, "data-duration", Number.MIN_VALUE),
		width: numberAttribute(path, "stroke-width", Number.MIN_VALUE),
	}));
}
