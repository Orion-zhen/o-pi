import { createContext } from "react";

export const FileLinksContext = createContext<{ cwd: string; openFile: (path: string) => void } | null>(null);

function segments(value: string): string[] | undefined {
	const parts: string[] = [];
	for (const part of value.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) return;
			parts.pop();
		} else parts.push(part);
	}
	return parts;
}

export function fileLinkPath(href: string, cwd: string): string | undefined {
	let target = href.trim();
	if (!target || /^[#?]/.test(target) || /^(?:\/\/|\\\\)/.test(target)) return;
	const windows = /^[a-z]:[/\\]/i.test(cwd);
	if (/^file:/i.test(target)) {
		try {
			const url = new URL(target);
			if (url.hostname) return;
			target = url.pathname;
			if (windows) target = target.replace(/^\/([a-z]:\/)/i, "$1");
		} catch { return; }
	} else {
		target = target.replace(/[?#].*$/s, "");
		const drive = /^[a-z]:[/\\]/i.test(target);
		const fileLine = /^[^/\\:]+\.[^/\\:]+:\d+(?::\d+)?$/.test(target);
		if (drive ? !windows : /^[a-z][a-z\d+.-]*:/i.test(target) && !fileLine) return;
	}
	target = target.replace(/:\d+(?::\d+)?$/, "");
	try { target = decodeURIComponent(target); }
	catch { return; }
	if (!target || /[\x00-\x1f\x7f]/.test(target)) return;
	if (windows) target = target.replace(/\\/g, "/");
	const base = windows ? cwd.replace(/\\/g, "/") : cwd;
	const absolute = target.startsWith("/") || (windows && /^[a-z]:\//i.test(target));
	const root = segments(base);
	const file = segments(absolute ? target : `${base}/${target}`);
	if (!root || !file || file.length <= root.length) return;
	if (!root.every((part, index) => windows ? part.toLowerCase() === file[index]?.toLowerCase() : part === file[index])) return;
	return file.slice(root.length).join("/");
}
