import { memo } from "react";
import type { GuiMessage } from "../../../../shared/messages/types.ts";
import { CodeBlock } from "@/ui/content/code-block.tsx";
import { MessageIdentity } from "./message-meta.tsx";
import { Content } from "./content.tsx";
import { clean } from "@/ui/content/format.ts";
import { SKILL_CONTEXT_MESSAGE } from "../../../../../harness/skill-context/types.ts";
import { isSkillLoadDetails } from "../../../../shared/messages/skill-facts.ts";
import { SkillCard } from "./skill-card.tsx";

export const Message = memo(function Message({ value, entryId }: { value: GuiMessage; entryId?: string | undefined }) {
	const role = value.role;
	if (value.role === "custom" && !value.display) return null;
	if (value.role === "custom" && value.customType === SKILL_CONTEXT_MESSAGE && isSkillLoadDetails(value.details)) {
		return <article className="message skill-message" data-entry-id={entryId}>
			<SkillCard id={`message:${entryId ?? value.timestamp}`} name={value.details.name} loadedBy={value.details.loadedBy}
				state="completed" output={{ kind: "inline", value: { content: value.content, details: value.details } }} />
		</article>;
	}
	return (
		<article className={`message ${role}`} data-entry-id={entryId}>
			{role === "user" && typeof value.timestamp === "number" && <MessageIdentity name="You" timestamp={value.timestamp} />}
			{role !== "user" && <header><strong>{value.role === "custom" ? value.customType : role}</strong></header>}
			{value.role === "bashExecution" ? <>
				<CodeBlock label="命令" language="bash" text={value.command} />
				<CodeBlock label="输出" text={clean(value.output)} />
			</> : value.role === "user" ? <div className="user-bubble"><Content value={value.content} /></div>
				: value.role === "compactionSummary" || value.role === "branchSummary" ? <Content value={value.summary} />
				: value.role === "toolResult" ? <Content value={value.output.kind === "inline" ? value.output.value.content : value.output.preview.content} />
				: <Content value={value.content} />}
			{value.role === "assistant" && value.errorMessage && <pre className="error">{value.errorMessage}</pre>}
		</article>
	);
});
