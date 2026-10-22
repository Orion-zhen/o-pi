import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, CornerUpRight, ListEnd, Square } from "lucide-react";
import { animate, motion, useDragControls, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { Crossfade } from "../components/animated";
import { Button } from "../components/ui/button";
import { Hint } from "../components/ui/tooltip";
import "./send-button.css";

// SVG 逻辑坐标不能过小，否则圆周长度测量失真。显示尺寸仍由 Grid 决定。
const SVG_SIZE = 100;
const fullScale = 1.06;
const wellRadius = SVG_SIZE * 0.6;
const fullStrokeWidth = SVG_SIZE * 0.06;
// 满蓄力时两个圆的外边缘分离，计入圆环线宽和按钮缩放。
const armRatio = (wellRadius + fullStrokeWidth / 2) / SVG_SIZE + fullScale / 2;

const variants = {
	send: { label: "发送", icon: ArrowUp },
	steer: { label: "发送", icon: CornerUpRight },
	"follow-up": { label: "发送", icon: ListEnd },
	stop: { label: "停止", icon: Square },
	"stop-compaction": { label: "停止压缩", icon: Square },
};

interface SendButtonProps {
	mode: keyof typeof variants;
	disabled: boolean;
	onActivate: () => void;
}

function bandPath(x: number, y: number, padRadius: number) {
	const distance = Math.hypot(x, y);
	const difference = wellRadius - padRadius;
	if (distance <= Math.abs(difference)) return "";
	const cosine = difference / distance;
	const sine = Math.sqrt(1 - cosine * cosine);
	// 外公切线同时计入底座半径和按钮缩放。
	return [-1, 1].map((side) => {
		const nx = x / distance * cosine - side * y / distance * sine;
		const ny = y / distance * cosine + side * x / distance * sine;
		return `M${wellRadius * nx},${wellRadius * ny}L${x + padRadius * nx},${y + padRadius * ny}`;
	}).join("");
}

export function SendButton({ mode, disabled, onActivate }: SendButtonProps) {
	const reducedMotion = useReducedMotion();
	const controls = useDragControls();
	const x = useMotionValue(0);
	const y = useMotionValue(0);
	const angle = useMotionValue(0);
	const [diameter, setDiameter] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [shot, setShot] = useState<number | null>(null);
	const held = useRef(false);
	const dragged = useRef(false);
	const cancelled = useRef(false);
	const gestureMode = useRef(mode);
	const pull = useRef({ x: 0, y: 0 });
	const enabled = !disabled && !reducedMotion;
	const { label, icon: Icon } = variants[mode];
	const maxPull = diameter * armRatio * 1.1;
	const distance = useTransform(() => Math.hypot(x.get(), y.get()));
	const power = useTransform(() => distance.get() === 0 ? 0 : Math.min(1, distance.get() / (diameter * armRatio)));
	const tension = useTransform(power, [0, 0.3], [0, 1]);
	const scale = useTransform(power, [0, 1], [1, fullScale]);
	const strokeWidth = useTransform(power, [0, 1], [SVG_SIZE * 0.04, fullStrokeWidth]);
	const band = useTransform(() => distance.get() === 0 ? "" : bandPath(
		x.get() / diameter * SVG_SIZE, y.get() / diameter * SVG_SIZE, scale.get() * SVG_SIZE / 2,
	));
	const cancel = useCallback(() => {
		if (!held.current) return;
		cancelled.current = true;
		controls.stop();
	}, [controls]);

	useEffect(() => { if (!enabled || mode !== gestureMode.current) cancel(); }, [enabled, mode, cancel]);
	useEffect(() => {
		if (!dragging) return;
		const abort = new AbortController();
		const options = { signal: abort.signal };
		window.addEventListener("keydown", (event) => {
			if (event.key === "Escape") { event.preventDefault(); cancel(); }
		}, options);
		window.addEventListener("blur", cancel, options);
		return () => abort.abort();
	}, [dragging, cancel]);
	useEffect(() => () => {
		held.current = false;
		controls.cancel();
		x.stop();
		y.stop();
		angle.stop();
	}, [controls, x, y, angle]);

	return <span className="sling-button" data-dragging={dragging}>
		<svg className="sling-art" viewBox={`${-SVG_SIZE / 2} ${-SVG_SIZE / 2} ${SVG_SIZE} ${SVG_SIZE}`} aria-hidden="true">
			<motion.g style={{ opacity: tension }}>
				<motion.path className="sling-band" d={band} style={{ strokeWidth }} />
				<circle className="sling-well" r={wellRadius} strokeWidth={SVG_SIZE * 0.025} />
				<motion.circle className="sling-power" r={wellRadius} pathLength={power} style={{ rotate: -90, strokeWidth }} />
			</motion.g>
			{shot !== null && [-0.36, -0.18, 0, 0.18, 0.36].map((spread, index) => {
				const reach = SVG_SIZE * (index === 2 ? 2.5 : 1.4 + index * 0.15);
				return <motion.circle key={index} className="sling-particle"
					initial={{ cx: 0, cy: 0, opacity: 1, r: SVG_SIZE * 0.05 }}
					animate={{ cx: Math.cos(shot + spread) * reach, cy: Math.sin(shot + spread) * reach, opacity: [1, 1, 0], r: SVG_SIZE * 0.01 }}
					transition={{ duration: 0.32, delay: 0.06, ease: [0.2, 0.8, 0.2, 1] }}
				/>;
			})}
		</svg>
		<Hint content={enabled ? `${label} · 拖动后松开可弹射` : label} disabled={dragging}>
			<Button asChild type="button" variant="default" size="icon" className="send-button" aria-label={label} disabled={disabled}>
				<motion.button
					data-sling-enabled={enabled}
					drag={enabled}
					dragControls={controls}
					dragConstraints={{ left: -maxPull, right: maxPull, top: -maxPull, bottom: maxPull }}
					dragElastic={0.08}
					dragSnapToOrigin
					dragTransition={{ bounceStiffness: 560, bounceDamping: 26 }}
					style={{ x, y, scale }}
					onPointerDown={(event) => {
						if (!event.isPrimary || event.button !== 0) return;
						dragged.current = false;
						cancelled.current = false;
						gestureMode.current = mode;
						const width = event.currentTarget.getBoundingClientRect().width / scale.get();
						setDiameter(width);
						setShot(null);
					}}
					onDragStart={() => { held.current = true; dragged.current = true; setDragging(true); }}
					onDrag={() => {
						pull.current = { x: x.get(), y: y.get() };
						angle.set(Math.atan2(-y.get(), -x.get()) * 180 / Math.PI + 90);
					}}
					onDragEnd={(event) => {
						if (!held.current) return;
						held.current = false;
						setDragging(false);
						void animate(angle, 0, { type: "spring", duration: 0.3, bounce: 0 });
						if (event.type === "pointerup" && !cancelled.current && enabled && mode === gestureMode.current
							&& Math.hypot(pull.current.x, pull.current.y) >= diameter * armRatio) {
							setShot(Math.atan2(-pull.current.y, -pull.current.x));
							onActivate();
						}
					}}
					onDragTransitionEnd={() => setShot(null)}
					onClick={(event) => {
						// 拖拽后的 click 不得再次发送，也不能误触刚切换的停止按钮。
						if (event.detail !== 0 && dragged.current) return;
						cancel();
						onActivate();
					}}
				>
					<motion.span className="sling-icon" style={{ rotate: angle }}><Crossfade value={mode}>
						<Icon fill={mode === "stop" || mode === "stop-compaction" ? "currentColor" : "none"} />
					</Crossfade></motion.span>
				</motion.button>
			</Button>
		</Hint>
	</span>;
}
