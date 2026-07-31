import {
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { EventBus } from "@earendil-works/pi-coding-agent";

import { queryThinkingDisplayCapability } from "./display-capability.js";

export interface ThinkingLevelOption {
	level: ModelThinkingLevel;
	label: string;
}

export interface ThinkingLevelSnapshot {
	model: { provider: string; id: string } | null;
	currentLevel: ModelThinkingLevel;
	options: ThinkingLevelOption[];
}

export type ThinkingLevelOutcome =
	| {
		status: "applied";
		code: "LEVEL_SET";
		requestedLevel: ModelThinkingLevel;
		effectiveLevel: ModelThinkingLevel;
		snapshot: ThinkingLevelSnapshot;
	}
	| {
		status: "rejected";
		code: "MODEL_REQUIRED";
		snapshot: ThinkingLevelSnapshot;
	}
	| {
		status: "rejected";
		code: "UNSUPPORTED_LEVEL";
		requestedLevel: string;
		availableLevels: ModelThinkingLevel[];
		snapshot: ThinkingLevelSnapshot;
	}
	| {
		status: "cancelled";
		code: "SELECTION_CANCELLED";
		snapshot: ThinkingLevelSnapshot;
	}
	| {
		status: "failed";
		code: "SET_FAILED";
		requestedLevel: ModelThinkingLevel;
		message: string;
		snapshot: ThinkingLevelSnapshot;
	};

export interface ThinkingLevelPort {
	getThinkingLevel(): ModelThinkingLevel;
	setThinkingLevel(level: ModelThinkingLevel): void;
	events?: EventBus;
}

/** 维护当前模型并集中计算、校验和变更 thinking level。 */
export class ThinkingLevelController {
	private model: Model<Api> | undefined;

	constructor(private readonly port: ThinkingLevelPort) {}

	updateModel(model: Model<Api> | undefined): ThinkingLevelSnapshot {
		this.model = model;
		return this.snapshot();
	}

	snapshot(model: Model<Api> | undefined = this.model): ThinkingLevelSnapshot {
		return {
			model: model === undefined ? null : { provider: model.provider, id: model.id },
			currentLevel: this.port.getThinkingLevel(),
			options: getThinkingLevelOptions(model, this.port.events),
		};
	}

	setLevel(value: string, model: Model<Api> | undefined = this.model): ThinkingLevelOutcome {
		this.model = model;
		const snapshot = this.snapshot();
		if (model === undefined) return { status: "rejected", code: "MODEL_REQUIRED", snapshot };

		const requestedLevel = value.trim().toLowerCase();
		const option = snapshot.options.find(({ level }) => level === requestedLevel);
		if (option === undefined) {
			return {
				status: "rejected",
				code: "UNSUPPORTED_LEVEL",
				requestedLevel,
				availableLevels: snapshot.options.map(({ level }) => level),
				snapshot,
			};
		}

		try {
			this.port.setThinkingLevel(option.level);
		} catch (error) {
			return {
				status: "failed",
				code: "SET_FAILED",
				requestedLevel: option.level,
				message: error instanceof Error ? error.message : String(error),
				snapshot: this.snapshot(),
			};
		}
		return {
			status: "applied",
			code: "LEVEL_SET",
			requestedLevel: option.level,
			effectiveLevel: this.port.getThinkingLevel(),
			snapshot: this.snapshot(),
		};
	}

	cancelSelection(model: Model<Api> | undefined = this.model): ThinkingLevelOutcome {
		this.model = model;
		return { status: "cancelled", code: "SELECTION_CANCELLED", snapshot: this.snapshot() };
	}

	findOptionByLabel(label: string, model: Model<Api> | undefined = this.model): ThinkingLevelOption | undefined {
		return this.snapshot(model).options.find((option) => option.label === label);
	}
}

/** 返回 Pi 判定为可用的等级，并展示最终请求使用的布尔或字符串映射。 */
export function getThinkingLevelOptions(
	model: Model<Api> | undefined,
	events?: EventBus,
): ThinkingLevelOption[] {
	if (model === undefined) return [];
	const booleanThinking = usesBooleanThinking(model)
		|| (events !== undefined && queryThinkingDisplayCapability(events, model) === "boolean");
	return getSupportedThinkingLevels(model).map((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		let label: string = level;
		if (booleanThinking) label = `${level} → ${level === "off" ? "disabled" : "enabled"}`;
		else if (typeof mapped === "string") label = `${level} → ${mapped}`;
		return { level, label };
	});
}

/** 根据模型最终生效的 compat 识别 chat_template_enabled，不耦合 provider 配置。 */
function usesBooleanThinking(model: Model<Api>): boolean {
	const compat = model.compat;
	if (
		compat === undefined
		|| !("thinkingFormat" in compat)
		|| compat.thinkingFormat !== "chat-template"
		|| !("chatTemplateKwargs" in compat)
	) return false;
	const value = compat.chatTemplateKwargs?.enable_thinking;
	return typeof value === "object" && value !== null && value.$var === "thinking.enabled";
}
