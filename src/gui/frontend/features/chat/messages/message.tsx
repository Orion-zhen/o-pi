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

export const BashExecution = memo(function BashExecution({ command, output, entryId }: {
	command: string;
	output: string;
	entryId?: string | undefined;
}) {
	return <article className="message bashExecution" data-entry-id={entryId}>
		<header><strong>bashExecution</strong></header>
		<CodeBlock label="命令" language="bash" text={command} />
		<CodeBlock label="输出" text={clean(output)} />
		<MessageFooter entryId={entryId} />
	</article>;
});

export const Message = memo(function Message({ value, entryId }: { value: GuiStandaloneMessage; entryId?: string | undefined }) {
	const role = value.role;
	if (value.role === "bashExecution") return <BashExecution command={value.command} output={value.output} entryId={entryId} />;
	if (value.role === "custom" && !value.display) return null;
	if (value.role === "custom" && value.customType === SKILL_CONTEXT_MESSAGE && isSkillLoadDetails(value.details)) {
		return <article className="message skill-message" data-entry-id={entryId}>
			<SkillCard id={`message:${entryId ?? value.timestamp}`} name={value.details.name} loadedBy={value.details.loadedBy}
				state="completed" output={{ kind: "inline", value: { content: value.content, details: value.details } }} />
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
