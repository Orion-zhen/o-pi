import { Fragment, useState } from "react";
import { ChevronRight, Eye, EyeOff } from "lucide-react";
import type { GuiBashApproval } from "../../../../shared/protocol/state.ts";
import { useOperation } from "@/connection/use-operation.ts";
import { Button } from "@/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { Feedback } from "@/ui/feedback.tsx";

type RevealProps = {
	revealed: boolean;
	reveal: () => Promise<GuiBashApproval>;
	change: (approval: GuiBashApproval | undefined) => void;
};

function SensitiveValues({ revealed, reveal, change }: RevealProps) {
	const { run, pending, error, reset } = useOperation(reveal, change);
	const Icon = revealed ? EyeOff : Eye;
	return <><Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => revealed ? reset(() => change(undefined)) : run()}>
		<Icon aria-hidden="true" />{revealed ? "隐藏敏感值" : "查看敏感值"}
	</Button><Feedback compact message={error} tone="error" /></>;
}

export function ApprovalEnvironment({ variables, canReveal, ...sensitive }: RevealProps & {
	variables: GuiBashApproval["environment"]; canReveal: boolean;
}) {
	const [open, setOpen] = useState(false);
	return <Collapsible className="approval-environment" open={open} onOpenChange={(next) => {
		setOpen(next);
		if (!next) sensitive.change(undefined);
	}}>
		<CollapsibleTrigger asChild><Button type="button" size="sm" variant="ghost" className="disclosure-trigger w-full justify-start">
			<ChevronRight aria-hidden="true" className="disclosure-chevron" />相关变量
			<span className="ms-auto text-xs font-normal tabular-nums text-muted-foreground">{variables.length} 项</span>
		</Button></CollapsibleTrigger>
		<CollapsibleContent lazy><div className="approval-variable-body">
			<dl className="approval-variable-list">{variables.map((entry) => <Fragment key={entry.name}>
				<dt><code>{entry.name}</code></dt>
				<dd>{entry.kind === "value" && entry.value !== "" ? <code>{entry.value}</code>
					: <span className="text-muted-foreground">{entry.kind === "unset" ? "未设置" : entry.kind === "hidden" ? "已隐藏" : "空字符串"}</span>}</dd>
			</Fragment>)}</dl>
			{open && canReveal && <SensitiveValues {...sensitive} />}
		</div></CollapsibleContent>
	</Collapsible>;
}
