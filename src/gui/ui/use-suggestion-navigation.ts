import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

export function useSuggestionNavigation(editor: RefObject<HTMLTextAreaElement | null>) {
	const ref = useRef<HTMLUListElement>(null);
	const focused = useRef<HTMLButtonElement | null>(null);
	useLayoutEffect(() => {
		if (focused.current && !focused.current.isConnected) {
			focused.current = null;
			if (document.activeElement === document.body) editor.current?.focus();
		}
	});
	return {
		ref,
		onFocus(event: FocusEvent<HTMLUListElement>) {
			if (event.target instanceof HTMLButtonElement) focused.current = event.target;
		},
		onBlur() {
			focused.current = null;
		},
		onKeyDown(event: KeyboardEvent<HTMLElement>): boolean {
			if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
			if (event.key === "Escape" && event.currentTarget === ref.current) {
				event.preventDefault();
				event.stopPropagation();
				editor.current?.focus();
				return true;
			}
			if (event.key !== "Tab" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
			if (event.shiftKey && event.key !== "Tab") return false;
			const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
			const current = buttons.findIndex((button) => button === document.activeElement);
			const direction = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1;
			const index = current < 0
				? (direction > 0 ? 0 : buttons.length - 1)
				: (current + direction + buttons.length) % buttons.length;
			const next = buttons[index];
			if (!next) return false;
			event.preventDefault();
			next.focus({ preventScroll: true });
			next.scrollIntoView({ block: "nearest", inline: "nearest" });
			return true;
		},
	};
}
