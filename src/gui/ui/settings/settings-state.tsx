import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SettingsCategory } from "./settings-navigation.ts";

type DraftActions = { save: () => Promise<boolean>; discard: () => void };
type DraftState = DraftActions & { title: string; dirty: boolean; blocked: boolean; invalid?: boolean };
type RegisteredDraft = DraftState & { category: SettingsCategory };
type Register = (id: string, draft: RegisteredDraft) => () => void;

export const SettingsStateContext = createContext<{ register: Register; saving: boolean } | null>(null);
export const SettingsCategoryContext = createContext<SettingsCategory>("appearance");

export function useSettingsState() {
	const context = useContext(SettingsStateContext);
	if (!context) throw new Error("设置编辑器缺少状态上下文");
	return context;
}

export function useSettingsDraft(id: string, { title, dirty, blocked, invalid = false, save, discard }: DraftState) {
	const { register } = useSettingsState();
	const category = useContext(SettingsCategoryContext);
	const actions = useRef<DraftActions>({ save, discard });
	useLayoutEffect(() => { actions.current = { save, discard }; });
	useEffect(() => register(id, {
		category, title, dirty, blocked, invalid,
		save: () => actions.current.save(), discard: () => actions.current.discard(),
	}), [id, category, title, dirty, blocked, invalid, register]);
}

export function useSettingsCoordinator(onDirty: (dirty: boolean) => void) {
	const [drafts, setDrafts] = useState(new Map<string, RegisteredDraft>());
	const [saving, setSaving] = useState(false);
	const pending = useRef(false);
	const active = useRef(true);
	useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const register = useCallback<Register>((id, draft) => {
		setDrafts((previous) => new Map(previous).set(id, draft));
		return () => setDrafts((previous) => {
			const next = new Map(previous);
			next.delete(id);
			return next;
		});
	}, []);
	const dirty = [...drafts.values()].filter((draft) => draft.dirty);
	const dirtyPages = new Set(dirty.map((draft) => draft.category));
	useEffect(() => { onDirty(dirty.length > 0 || saving); }, [dirty.length, saving, onDirty]);
	const blocked = dirty.some((draft) => draft.blocked || draft.invalid);
	const save = async () => {
		if (pending.current || blocked || dirty.length === 0) return;
		pending.current = true;
		setSaving(true); setStatus(""); setError("");
		const failures: string[] = [];
		try {
			// 按文件依次提交，失败项保留草稿，其余项继续保存。
			for (const draft of dirty) {
				if (!active.current) return;
				try {
					if (!await draft.save()) failures.push(draft.title);
				} catch (error) {
					failures.push(`${draft.title}：${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (!active.current) return;
			if (failures.length) setError(`未保存：${failures.join("、")}`);
			else setStatus("已保存");
		} finally { pending.current = false; if (active.current) setSaving(false); }
	};
	const discard = () => {
		if (pending.current) return;
		for (const draft of dirty) draft.discard();
		setStatus(""); setError("");
	};
	return { register, saving, dirtyPages, blocked, status, error, save, discard };
}
