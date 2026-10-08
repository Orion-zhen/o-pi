import type { ReactNode } from "react";
import { useReplyAnimation } from "./use-reply-animation.ts";

export function ReplyStatusLabel({ active, className = "", children }: { active: boolean; className?: string; children: ReactNode }) {
	const { ref } = useReplyAnimation<HTMLSpanElement>(active);
	return <span ref={ref} className={`reply-status-label ${className}`} data-active={active}>{children}</span>;
}
