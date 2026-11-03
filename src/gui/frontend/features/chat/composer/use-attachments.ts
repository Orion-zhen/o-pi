import { useEffect, useState } from "react";
import type { SessionViews, SessionViewState } from "@/features/sessions/session-views.ts";
import { prepareAttachments } from "./attachments.ts";

export function useAttachments(view: SessionViewState, views: SessionViews, setError: (message: string) => void) {
	// Composer 按会话 ID 重新挂载，所有附件共用该次挂载的取消信号。
	const [controller] = useState(() => new AbortController());
	const { signal } = controller;
	const [pending, setPending] = useState(0);
	useEffect(() => () => controller.abort(), [controller]);

	const attach = async (files: File[]) => {
		setPending((count) => count + 1);
		try {
			const additions = await prepareAttachments(files, signal);
			signal.throwIfAborted();
			views.update(view, (draft) => {
				const images = [...draft.images, ...additions.images];
				if (images.length > 8) throw new Error("最多上传 8 张图片。");
				return { ...draft, images, text: [draft.text, ...additions.texts].join("\n\n") };
			});
		} catch (error) {
			if (!signal.aborted) setError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending((count) => count - 1);
		}
	};
	return { attach, pending: pending > 0 };
}
