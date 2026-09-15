import type { GuiSnapshot } from "../contract.ts";
import type { Send } from "./dialog.tsx";
import { NativeSelect } from "./components/ui/native-select";

export function ThinkingControl({
	snapshot,
	send,
	disabled = false,
}: {
	snapshot: GuiSnapshot;
	send: Send;
	disabled?: boolean;
}) {
	return (
		<NativeSelect
			aria-label="思考级别"
			value={snapshot.thinking}
			disabled={disabled || snapshot.busy || snapshot.streaming}
			onChange={(event) => {
				const level = snapshot.thinkingLevels.find((level) => level === event.target.value);
				if (level) void send({ action: "thinking", level });
			}}
		>
			{snapshot.thinkingLevels.map((level) => (
				<option key={level}>{level}</option>
			))}
		</NativeSelect>
	);
}

export function ModelControls({ snapshot, send }: { snapshot: GuiSnapshot; send: Send }) {
	const available = new Map(snapshot.models.map((model) => [`${model.provider}/${model.id}`, model]));
	const models = snapshot.scopedModels.flatMap((id) => {
		const model = available.get(id);
		return model ? [model] : [];
	});
	const current = snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "";
	if (snapshot.model && !models.some((model) => `${model.provider}/${model.id}` === current))
		models.push(snapshot.model);
	return (
		<div className="model-controls">
			<NativeSelect
				aria-label="模型"
				title={current || "请在侧栏选择模型"}
				value={current}
				disabled={snapshot.busy || snapshot.streaming || !models.length}
				onChange={(event) => {
					const model = available.get(event.target.value);
					if (model) void send({ action: "model", provider: model.provider, id: model.id });
				}}
			>
				{!snapshot.model && (
					<option value="" disabled hidden>
						{models.length ? "选择模型" : "请在侧栏选择模型"}
					</option>
				)}
				{models.map((model) => (
					<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
						{model.name}
					</option>
				))}
			</NativeSelect>
			<ThinkingControl snapshot={snapshot} send={send} />
		</div>
	);
}
