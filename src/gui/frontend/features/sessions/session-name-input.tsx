import { useEffect, useRef } from "react";

export function SessionNameInput({ name, finish }: { name: string; finish: (name: string) => void }) {
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (event.target !== input.current) input.current?.blur();
		};
		const cancel = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing || !input.current) return;
			event.preventDefault();
			event.stopPropagation();
			input.current.value = name;
			input.current.blur();
		};
		document.addEventListener("pointerdown", outside, true);
		window.addEventListener("keydown", cancel, true);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("keydown", cancel, true);
		};
	}, [name]);
	return <input ref={input} className="session-name" aria-label="会话名称" defaultValue={name}
		maxLength={4096} autoFocus onFocus={(event) => event.currentTarget.select()}
		onBlur={(event) => finish(event.currentTarget.value.trim() || name)}
		onKeyDown={(event) => {
			if (event.nativeEvent.isComposing) return;
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.blur();
			}
		}} />;
}
