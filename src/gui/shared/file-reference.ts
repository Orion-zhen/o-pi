export function fileReference(path: string): string {
	if (/[\r\n]/.test(path) || (path.includes('"') && path.includes("'"))) throw new Error("此文件名不能表示为 @ 引用。");
	const quoted = /[\s'"]/.test(path) ? (path.includes('"') ? `'${path}'` : `"${path}"`) : path;
	return `@${quoted} `;
}
