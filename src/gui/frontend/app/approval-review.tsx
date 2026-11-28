import { useMemo, type ReactNode } from "react";
import { Bot, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReviewState } from "../../../harness/approval/runtime/ai-review.ts";
import type { GuiApprovalContent } from "../../shared/protocol/state.ts";
import type { ResponseControls } from "./approval-actions.tsx";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Fade } from "@/ui/motion/animated.tsx";
import { motionDuration } from "@/ui/motion/transitions.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover.tsx";
import { useTextOverflow } from "@/ui/use-text-overflow.ts";

function ReviewReason({ reason }: { reason: string }) {
	const { ref, overflow } = useTextOverflow(reason);
	return <>
		<div ref={ref} className="line-clamp-2">{reason}</div>
		{overflow && <Popover><PopoverTrigger asChild><IconButton label="完整 AI 意见" size="icon-xs" className="group">
				<Plus aria-hidden="true" className="transition-transform group-aria-expanded:rotate-45" />
			</IconButton></PopoverTrigger>
			<PopoverContent side="top" align="end" aria-label="完整 AI 意见" className="review-reason-detail" tabIndex={0}>{reason}</PopoverContent>
		</Popover>}
	</>;
}

export function ApprovalStatus({ review, deadline }: { review: ReviewState | undefined; deadline: ReactNode }) {
	return <div className="relative" aria-live="polite"><AnimatePresence initial={false} mode="popLayout">
		{(review || deadline) && <Fade key={review?.kind ?? "deadline"} className="approval-status">
			{review && <div className="approval-review-copy">
				<Bot role="img" aria-label="AI 意见" className="size-[1.15em] shrink-0" />
				{review.kind === "ready" ? <ReviewReason reason={review.reason} />
					: review.kind === "running" ? <motion.span className="approval-review-shimmer"
						animate={{ backgroundPosition: ["100% center", "0% center"] }}
						transition={{ duration: motionDuration[7], ease: "easeInOut", repeat: Infinity, repeatDelay: motionDuration[6] }}>
						正在生成审批意见
					</motion.span> : "无法获取意见，请手动决定"}
			</div>}
			{deadline && <div className="approval-deadline" aria-live="off">{deadline}</div>}
		</Fade>}
	</AnimatePresence></div>;
}

export function ChoiceButton({ option: { value, label }, review, respond, pending }: ResponseControls & { option: GuiApprovalContent["options"][number]; review: ReviewState | undefined }) {
	const candidate = Boolean(review) && (value === "Allow once" || value === "Deny");
	const ready = review?.kind === "ready" && value === (review.decision === "allow" ? "Allow once" : "Deny") ? review : undefined;
	const style = useMemo(() => ready && ready.end !== null ? { animationDuration: `${ready.end - ready.start}ms`, animationDelay: `${-Math.max(0, Date.now() - ready.start)}ms` } : undefined, [ready?.start, ready?.end]);
	return <Button variant="outline" className="approval-choice" data-suggested={Boolean(ready)} data-auto-apply={style ? true : undefined} style={style}
		aria-description={ready ? `AI 建议${label}${style ? "，进度填满后自动采纳" : ""}` : undefined} disabled={pending} onClick={() => respond(value)}>
		{candidate && <span className="approval-choice-icon" aria-hidden="true">{ready && <Bot />}</span>}<span>{label}</span>
	</Button>;
}
