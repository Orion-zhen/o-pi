import { useEffect, useRef, useState } from "react";
import type { Send } from "./dialog.tsx";

export function SessionHeading({ name, send }: { name: string; send: Send }) {
	const [editing, setEditing] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!editing) return;
		const outside = (event: PointerEvent) => {
			if (event.target !== input.current) input.current?.blur();
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [editing]);
	return (
		<div className="session-heading">
			{editing ? (
				<input
					ref={input}
					className="session-name"
					aria-label="会话名称"
					defaultValue={name}
					maxLength={4096}
					autoFocus
					onFocus={(event) => event.currentTarget.select()}
					onBlur={(event) => {
						const value = event.currentTarget.value.trim();
						setEditing(false);
						if (value && value !== name) void send({ action: "rename", name: value });
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (event.key === "Escape") event.currentTarget.value = name;
						if (event.key === "Enter" || event.key === "Escape") {
							event.preventDefault();
							event.currentTarget.blur();
						}
					}}
				/>
			) : (
				<button type="button" className="session-name" title="重命名会话" onClick={() => setEditing(true)}>
					{name || "新会话"}
				</button>
			)}
		</div>
	);
}
