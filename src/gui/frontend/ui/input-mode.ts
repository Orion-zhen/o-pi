export function isTouchInput(): boolean {
	return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}
