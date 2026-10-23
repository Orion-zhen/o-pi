export const MAX_MERMAID_SOURCE_LENGTH = 30_000;

export function validateMermaidSource(source: string): void {
	if (source.length > MAX_MERMAID_SOURCE_LENGTH) throw new Error("图表源码超过 30000 字符，请拆分图表。");
	// 样式在临时 DOM 中参与测量前禁止资源引用，包括 CSS 转义和注释拼接。
	const decoded = source.replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex: string | undefined, character: string | undefined) =>
		hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : character ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
	if (/\b(?:url|image-set|image|src)\s*\(|@import|\bimg["']?\s*:/i.test(decoded))
		throw new Error("图表不支持嵌入图片或外部资源。");
}
