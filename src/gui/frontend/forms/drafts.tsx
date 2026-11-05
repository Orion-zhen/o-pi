import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useOperation } from "@/connection/use-operation.ts";

export type DraftPlan = { state: "clean" } | { state: "invalid" } | { state: "ready"; save: () => Promise<void> };
type DraftState = { title: string; blocked: boolean; plan: DraftPlan; discard: () => void };
type DraftCommands = Pick<DraftState, "plan" | "discard">;
type RegisteredDraft = Pick<DraftState, "title" | "blocked"> & {
	categories: readonly string[];
	state: DraftPlan["state"];
	commands: RefObject<DraftCommands>;
};
type SetDraft = (id: string, draft: RegisteredDraft | null) => void;

export const SettingsStateContext = createContext<{ setDraft: SetDraft; saving: boolean } | null>(null);
export const SettingsCategoryContext = createContext<string>("appearance");

export function useSettingsState() {
	const context = useContext(SettingsStateContext);
	if (!context) throw new Error("设置编辑器缺少状态上下文");
	return context;
}

export function useSettingsDraft(id: string, { categories, title, blocked, plan, discard }: DraftState & { categories?: readonly string[] }) {
	const { setDraft } = useSettingsState();
	const category = useContext(SettingsCategoryContext);
	const commands = useRef({ plan, discard });
	useLayoutEffect(() => { commands.current = { plan, discard }; });
	useLayoutEffect(() => {
		setDraft(id, { title, blocked, state: plan.state, categories: categories ?? [category], commands });
	}, [id, category, categories, title, blocked, plan.state, setDraft]);
	useLayoutEffect(() => () => setDraft(id, null), [id, setDraft]);
}

type Write = { title: string; save: () => Promise<void> };
function savePlan(drafts: Iterable<RegisteredDraft>): Write[] | null {
	const writes: Write[] = [];
	for (const draft of drafts) {
		const plan = draft.commands.current.plan;
		if (plan.state === "clean") continue;
		if (draft.blocked || plan.state === "invalid") return null;
		writes.push({ title: draft.title, save: plan.save });
	}
	return writes.length ? writes : null;
}

export function useSettingsCoordinator(onDirty: (dirty: boolean) => void) {
	const [drafts, setDrafts] = useState(new Map<string, RegisteredDraft>());
	const active = useRef(true);
	useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
	const operation = useOperation(async (writes: Write[]) => {
		const failures: string[] = [];
		// 按文件依次提交，失败项保留草稿，其余项继续保存。关闭后不再发起后续写入。
		for (const draft of writes) {
			if (!active.current) break;
			try { await draft.save(); }
			catch (error) { failures.push(`${draft.title}：${error instanceof Error ? error.message : String(error)}`); }
		}
		return failures;
	});
	const setDraft = useCallback<SetDraft>((id, draft) => {
		setDrafts((previous) => {
			const next = new Map(previous);
			if (draft === null) next.delete(id);
			else next.set(id, draft);
			return next;
		});
	}, []);
	const dirty = [...drafts.values()].filter((draft) => draft.state !== "clean");
	const dirtyPages = new Set(dirty.flatMap((draft) => draft.categories));
	const saving = operation.pending;
	useEffect(() => { onDirty(dirty.length > 0 || saving); }, [dirty.length, saving, onDirty]);
	const blocked = dirty.length === 0 || dirty.some((draft) => draft.blocked || draft.state === "invalid");
	const save = () => { const writes = savePlan(drafts.values()); if (writes) operation.run(writes); };
	const discard = () => operation.reset(() => {
		for (const draft of dirty) draft.commands.current.discard();
	});
	const result = operation.state;
	const error = result.state === "succeeded" && result.value.length ? `未保存：${result.value.join("、")}` : operation.error;
	const status = result.state === "succeeded" && !result.value.length ? "已保存" : "";
	return { setDraft, saving, dirtyPages, blocked, status, error, save, discard };
}
