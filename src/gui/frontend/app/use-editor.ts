import { useCallback, useRef, useState } from "react";
import type { SessionViews, SessionViewState } from "@/features/sessions/session-views.ts";
import { fileReference } from "../../shared/file-reference.ts";

export function useEditor(view: SessionViewState | undefined, views: SessionViews, reportError: (error: unknown) => void) {
	const input = useRef<HTMLTextAreaElement>(null);
	const [referenceVersion, setReferenceVersion] = useState(0);
	const setDraft = useCallback((text: string) => { if (view) views.writeText(view.id, text); }, [view, views]);
	const referenceFile = useCallback((path: string) => {
		if (!view) return false;
		let reference: string;
		try { reference = fileReference(path); }
		catch (error) { reportError(error); return false; }
		views.update(view, (draft) => ({ ...draft, text: `${draft.text}${draft.text && !/\s$/.test(draft.text) ? " " : ""}${reference}` }));
		input.current?.focus();
		setReferenceVersion((version) => version + 1);
		return true;
	}, [view, views, reportError]);
	return { input, views, setDraft, referenceFile, referenceVersion };
}
