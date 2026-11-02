import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Element, Root } from "hast";
import { ContentVisible } from "../collapsible.tsx";
import "./text-reveal.css";

const RevealFrame = createContext({ text: "", enabled: false, from: 0 });

export function TextReveal({ text, active, children }: { text: string; active: boolean; children: ReactNode }) {
	const contentVisible = useContext(ContentVisible);
	const [visible, setVisible] = useState(true);
	useEffect(() => {
		if (!active || !contentVisible) return;
		const update = () => setVisible(!document.hidden);
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, [active, contentVisible]);
	const enabled = active && contentVisible && visible;
	const [frame, setFrame] = useState({ text, enabled, from: text.length, visible, resume: !visible });
	if (text !== frame.text || enabled !== frame.enabled || visible !== frame.visible) {
		// 页面恢复后的首批更新来自宿主重同步，只重建基线，不补播后台文字。
		const resumed = visible && !frame.visible;
		const append = enabled && frame.enabled && !frame.resume && !resumed && text.startsWith(frame.text);
		setFrame({ text, enabled, from: append ? frame.text.length : text.length, visible,
			resume: !visible || (frame.resume || resumed) && text === frame.text });
	}
	return <RevealFrame value={frame}>{children}</RevealFrame>;
}

type Piece = { from: number; to: number };
type TextState = { text: string; enabled: boolean; settled: number; pieces: Piece[] };

export function RevealedText({ text, start }: { text: string; start: number }) {
	const frame = useContext(RevealFrame);
	const [state, setState] = useState<TextState>(() => {
		const reveal = frame.enabled && start >= frame.from;
		return { text, enabled: frame.enabled, settled: reveal ? 0 : text.length,
			pieces: reveal ? [{ from: 0, to: text.length }] : [] };
	});
	if (text !== state.text || frame.enabled !== state.enabled) {
		const append = frame.enabled && state.enabled && frame.from < frame.text.length && text.startsWith(state.text);
		setState({ text, enabled: frame.enabled, settled: append ? state.settled : text.length,
			pieces: append ? [...state.pieces, { from: state.text.length, to: text.length }] : [] });
	}
	return <>{state.text.slice(0, state.settled)}{state.pieces.map((piece) =>
		<span key={piece.from} className="text-reveal" onAnimationEnd={() => setState((current) => {
			const settled = Math.max(current.settled, piece.to);
			return { ...current, settled, pieces: current.pieces.filter((pending) => pending.to > settled) };
		})}>{state.text.slice(piece.from, piece.to)}</span>,
	)}</>;
}

export function rehypeTextReveal() {
	return function visit(parent: Root | Element): void {
		for (const [index, child] of parent.children.entries()) {
			if (child.type === "text" && child.position?.start.offset !== undefined) {
				parent.children[index] = { type: "element", tagName: "span", properties: { dataTextStart: child.position.start.offset }, children: [child] };
			} else if (child.type === "element" && !["pre", "code", "span"].includes(child.tagName)) visit(child);
		}
	};
}
