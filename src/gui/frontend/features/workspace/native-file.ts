import type { HTMLAttributes } from "react";

export function nativeFileEvents(cwd: string, path: string, file: boolean, report: (message: string) => void): HTMLAttributes<HTMLElement> {
	const desktop = window.opi;
	if (!desktop) return {};
	return {
		draggable: file,
		onContextMenu(event) {
			event.preventDefault(); event.stopPropagation();
			void desktop.fileMenu(cwd, path).catch((error: unknown) => report(String(error)));
		},
		onDragStart(event) {
			event.preventDefault();
			if (file) void desktop.startDrag(cwd, path).catch((error: unknown) => report(String(error)));
		},
	};
}
