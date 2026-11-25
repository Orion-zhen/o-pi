import { memo } from "react";
import type { GuiStandaloneMessage } from "../../../../shared/messages/types.ts";
import { CodeBlock } from "@/ui/content/code-block.tsx";
import { MessageIdentity } from "./message-meta.tsx";
import { MessageFooter } from "./message-footer.tsx";
import { Content } from "./content.tsx";
import { clean } from "@/ui/content/format.ts";
import { SKILL_CONTEXT_MESSAGE } from "../../../../../harness/skill-context/types.ts";
import { isSkillLoadDetails } from "../../../../shared/messages/skill-facts.ts";
import { SkillCard } from "./skill-card.tsx";

type BashMessage = Extract<GuiStandaloneMessage, { role: "bashExecution" }>;
type BashProps = Pick<BashMessage, "command" | "output" | "fullOutputPath" | "fullOutputError"> & { truncated?: boolean; entryId?: string | undefined };

export const BashExecution = memo(function BashExecution({ command, output, truncated, fullOutputPath, fullOutputError, entryId }: BashProps) {
	return <article className="message bashExecution" data-entry-id={entryId}>
		<header><strong>bashExecution</strong></header>
		<CodeBlock label="命令" language="bash" text={command} />
		<CodeBlock label="输出" text={clean(output)} />
		{truncated && <p>输出已截断{fullOutputPath ? `，完整日志：${fullOutputPath}` : fullOutputError ? `，无法保存完整日志：${fullOutputError}` : ""}</p>}
		<MessageFooter entryId={entryId} />
	</article>;
});

export const Message = memo(function Message({ value, entryId }: { value: GuiStandaloneMessage; entryId?: string | undefined }) {
	const role = value.role;
	if (value.role === "bashExecution") return <BashExecution {...value} entryId={entryId} />;
	if (value.role === "custom" && !value.display) return null;
	if (value.role === "custom" && value.customType === SKILL_CONTEXT_MESSAGE && isSkillLoadDetails(value.details)) {
		return <article className="message skill-message" data-entry-id={entryId}>
			<SkillCard id={`message:${entryId ?? value.timestamp}`} name={value.details.name} loadedBy={value.details.loadedBy}
				state="completed" output={{ kind: "inline", value: { view: "raw", facts: "", error: "", aborted: false, content: value.content, details: value.details } }} />
			<MessageFooter entryId={entryId} />
		</article>;
	}
	return (
		<article className={`message ${role}`} data-entry-id={entryId}>
			{role === "user" && typeof value.timestamp === "number" && <MessageIdentity name="You" timestamp={value.timestamp} />}
			{role !== "user" && <header><strong>{value.role === "custom" ? value.customType : role}</strong></header>}
			{value.role === "user" ? <div className="user-bubble"><Content value={value.content} /></div>
				: value.role === "compactionSummary" || value.role === "branchSummary" ? <Content value={value.summary} />
				: <Content value={value.content} />}
			<MessageFooter entryId={entryId} />
		</article>
	);
});
