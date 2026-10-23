import { Circle, Shield, Square, type IconNode } from "lucide";

// 填充属于图形数据，才能让 Morphicons 在实心与描边之间变形。
function filled(icon: IconNode): IconNode {
	return icon.map(([element, attributes]) => [element, { ...attributes, fill: "currentColor", stroke: "currentColor" }]);
}

export const FilledShield = filled(Shield);
export const FilledSquare = filled(Square);
export const StatusDot: IconNode = Circle.map(([element, attributes]) => [element, { ...attributes, r: "6", fill: "currentColor", stroke: "none" }]);
