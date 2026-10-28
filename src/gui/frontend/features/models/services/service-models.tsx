import { useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Plus } from "lucide-react";
import type { ModelCandidate } from "../../../../../harness/model-services/model-candidates.ts";
import { configuredModels } from "../../../../../harness/model-services/model-settings.ts";
import type { ConfigObject } from "../../../../../harness/model-services/document.ts";
import { modelSettingsView } from "../../../../../harness/model-services/settings-view.ts";
import { Button } from "@/ui/button.tsx";
import { Reveal } from "@/ui/motion/animated.tsx";
import type { ChangeConfig } from "./service-draft.ts";
import { AddServiceItem } from "./add-service-item.tsx";
import { ModelItem } from "./model-item.tsx";

export function ServiceModels({ providerId, provider, candidates, disabled, change, actions, status }: {
	providerId: string;
	provider: ConfigObject;
	candidates: ModelCandidate[];
	disabled: boolean;
	change: ChangeConfig;
	actions?: ReactNode;
	status?: string;
}) {
	const [adding, setAdding] = useState(false);
	const addButton = useRef<HTMLButtonElement>(null);
	const cancel = () => { setAdding(false); addButton.current?.focus(); };
	const [expanded, setExpanded] = useState<string>();
	const models = configuredModels(provider);
	const definitions = models.filter((model) => model.manualIndex !== undefined).map(({ id }) => id);
	const move = (index: number, direction: -1 | 1) => {
		const next = [...provider.models as ConfigObject[]];
		next.splice(index + direction, 0, ...next.splice(index, 1));
		change(["models"], next);
	};
	const defined = new Set(definitions);
	const available = candidates.filter(({ id }) => !defined.has(id));
	const add = (id: string) => {
		const model = available.find((model) => model.id === id) ?? { id };
		const index = Array.isArray(provider.models) ? provider.models.length : 0;
		change(["models", index], model);
		setAdding(false);
		setExpanded(id);
	};

	return <section className="service-models" aria-label="服务模型">
		<header className="service-section-heading">
			<div className="service-section-title">
				<h4>模型</h4><span className="service-model-count" role="status">{models.length} 个模型</span>
			</div>
			<div className="service-section-actions">
				{actions}
				<Button ref={addButton} variant="ghost" size="sm" disabled={disabled} aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus />添加模型</Button>
			</div>
		</header>
		{status && <p className="service-tag" role="status">{status}</p>}
		<AnimatePresence initial={false}>{adding && <Reveal key="add">
			<AddServiceItem label="模型 ID" disabled={disabled} existing={definitions}
				suggestions={available.map(({ id }) => id)} cancel={cancel} add={add} />
		</Reveal>}</AnimatePresence>
		<div className="service-model-list"><AnimatePresence initial={false}>
			{models.map((model) => <ModelItem key={model.id} model={model} settings={modelSettingsView(providerId, provider, model)}
				open={expanded === model.id} setOpen={(open) => setExpanded(open ? model.id : undefined)}
				disabled={disabled} change={change} modelCount={definitions.length} move={move} />)}
		</AnimatePresence></div>
		{models.length === 0 && !adding && <p className="settings-empty">暂无模型</p>}
	</section>;
}
