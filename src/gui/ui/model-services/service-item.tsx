import { ChevronRight } from "lucide-react";
import { editModelsDocument } from "../../../harness/openai-compatible-provider/config-edits.ts";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { ConfirmAction } from "../components/confirm-action.tsx";
import { Reveal } from "../components/animated.tsx";
import { ServiceForm, type ServiceFormProps } from "./service-form.tsx";
import { textValue } from "./service-fields.tsx";

function serviceAddress(value: unknown): string {
	if (typeof value !== "string") return "";
	try { return new URL(value).host; } catch { return ""; }
}

export function ServiceItem({ open, setOpen, ...form }: ServiceFormProps & {
	open: boolean;
	setOpen: (open: boolean) => void;
}) {
	const { id, config, disabled, changeDraft } = form;
	const name = textValue(config.name) || id;
	const address = serviceAddress(config.baseUrl);
	const remove = async () => changeDraft((current) => editModelsDocument(current, ["providers", id], undefined));

	return <Reveal><Collapsible open={open} onOpenChange={setOpen} asChild>
		<article className="model-service" aria-label={`模型服务 ${id}`}>
			<div className="service-item-heading">
				<CollapsibleTrigger className="service-summary" aria-label={`编辑服务 ${id}`}>
					<strong>{name}</strong><span>{id}{address ? ` · ${address}` : ""}</span>
				</CollapsibleTrigger>
				<span className="service-tag">{config.api === "openai-responses" ? "Responses" : "Chat Completions"}</span>
				<div className="service-item-actions">
					<ConfirmAction label={`删除服务 ${id}`} disabled={disabled} confirm={remove} />
					<CollapsibleTrigger className="disclosure-trigger" asChild>
						<Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"}服务 ${id}`}>
							<ChevronRight className="disclosure-chevron" />
						</Button>
					</CollapsibleTrigger>
				</div>
			</div>
			<CollapsibleContent lazy><ServiceForm {...form} /></CollapsibleContent>
		</article>
	</Collapsible></Reveal>;
}
