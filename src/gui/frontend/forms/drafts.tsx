import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

type DraftState = { title: string; dirty: boolean; blocked: boolean; save: (() => Promise<void>) | null; discard: () => void };
type DraftCommands = Pick<DraftState, "save" | "discard">;
type RegisteredDraft = Pick<DraftState, "title" | "dirty" | "blocked"> & {
	categories: readonly string[];
	invalid: boolean;
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

export function useSettingsDraft(id: string, { categories, title, dirty, blocked, save, discard }: DraftState & { categories?: readonly string[] }) {
	const { setDraft } = useSettingsState();
	const category = useContext(SettingsCategoryContext);
	const commands = useRef({ save, discard });
	useLayoutEffect(() => { commands.current = { save, discard }; });
	const invalid = save === null;
	useLayoutEffect(() => {
		setDraft(id, { title, dirty, blocked, invalid, categories: categories ?? [category], commands });
	}, [id, category, categories, title, dirty, blocked, invalid, setDraft]);
	useLayoutEffect(() => () => setDraft(id, null), [id, setDraft]);
}

function savePlan(drafts: Iterable<RegisteredDraft>) {
	const writes: { title: string; save: () => Promise<void> }[] = [];
	for (const draft of drafts) {
		if (!draft.dirty) continue;
		const { save } = draft.commands.current;
		if (draft.blocked || save === null) return null;
		writes.push({ title: draft.title, save });
	}
	return writes.length ? writes : null;
}

export function useSettingsCoordinator(onDirty: (dirty: boolean) => void) {
	const [drafts, setDrafts] = useState(new Map<string, RegisteredDraft>());
	const [saving, setSaving] = useState(false);
	const pending = useRef(false);
	const active = useRef(true);
	useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const setDraft = useCallback<SetDraft>((id, draft) => {
		setDrafts((previous) => {
			const next = new Map(previous);
			if (draft === null) next.delete(id);
			else next.set(id, draft);
			return next;
		});
	}, []);
	const dirty = [...drafts.values()].filter((draft) => draft.dirty);
	const dirtyPages = new Set(dirty.flatMap((draft) => draft.categories));
	useEffect(() => { onDirty(dirty.length > 0 || saving); }, [dirty.length, saving, onDirty]);
	const blocked = dirty.length === 0 || dirty.some((draft) => draft.blocked || draft.invalid);
	const save = async () => {
		const writes = savePlan(drafts.values());
		if (pending.current || writes === null) return;
		pending.current = true;
		setSaving(true); setStatus(""); setError("");
		const failures: string[] = [];
		try {
			// 按文件依次提交，失败项保留草稿，其余项继续保存。
			for (const draft of writes) {
				if (!active.current) return;
				try { await draft.save(); }
				catch (error) { failures.push(`${draft.title}：${error instanceof Error ? error.message : String(error)}`); }
			}
			if (!active.current) return;
			if (failures.length) setError(`未保存：${failures.join("、")}`);
			else setStatus("已保存");
		} finally { pending.current = false; if (active.current) setSaving(false); }
	};
	const discard = () => {
		if (pending.current) return;
		for (const draft of drafts.values()) if (draft.dirty) draft.commands.current.discard();
		setStatus(""); setError("");
	};
	return { setDraft, saving, dirtyPages, blocked, status, error, save, discard };
}
