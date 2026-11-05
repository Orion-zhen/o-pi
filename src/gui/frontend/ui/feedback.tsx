import type { ReactNode } from "react";
import type { FeedbackTone } from "../../shared/protocol/events.ts";
import { AnimatePresence } from "motion/react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide";
import { MorphIcon } from "morphicons/react";
import { Fade, Reveal } from "./motion/animated.tsx";
import { Disclosure } from "./disclosure.tsx";
import { Button } from "./button.tsx";
import { useClipboard } from "./use-clipboard.ts";
import { useTextOverflow } from "./use-text-overflow.ts";
import "./feedback.css";

const icons = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

export function FeedbackIcon({ tone }: { tone: FeedbackTone }) {
	return <MorphIcon icon={icons[tone]} spring="smooth" size="1em" className="feedback-icon" />;
}

export function Feedback({ message, tone = "info", variant = "inline", compact = variant === "banner", children, id }: {
	message: string; tone?: FeedbackTone | undefined; variant?: "inline" | "banner"; compact?: boolean; children?: ReactNode; id?: string;
}) {
	const { ref, overflow } = useTextOverflow(message, compact);
	return <AnimatePresence propagate>{message && <Reveal className={`feedback feedback-${variant}`} data-tone={tone}>
		<div className="feedback-row">
			{(variant === "banner" || tone === "error" || tone === "warning") && <FeedbackIcon tone={tone} />}
			<Fade key={message} ref={ref} id={id} className="feedback-message" data-compact={compact} role={tone === "error" ? "alert" : "status"}>
				{message}
			</Fade>
			{children && <div className="feedback-actions">{children}</div>}
		</div>
		{overflow && <Disclosure key={message} summary="查看详情" className="feedback-details" lazy>
			<FeedbackDetails message={message} />
		</Disclosure>}
	</Reveal>}</AnimatePresence>;
}

export function FeedbackDetails({ message }: { message: string }) {
	const { status, copy } = useClipboard();
	return <div className="feedback-detail-content">
		<pre tabIndex={0}>{message}</pre>
		<Button variant="ghost" size="sm" onClick={() => void copy(message)}>
			{status === "copied" ? "已复制" : status === "error" ? "复制失败" : "复制原文"}
		</Button>
	</div>;
}
