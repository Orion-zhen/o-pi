import { useState } from "react";
import { useOperation } from "@/connection/use-operation.ts";

interface LocalFontWindow extends Window {
	queryLocalFonts?: () => Promise<{ family: string }[]>;
}

export type LocalFonts = ReturnType<typeof useLocalFonts>;

export function useLocalFonts() {
	const [fonts, setFonts] = useState<string[]>();
	const localWindow: LocalFontWindow = window;
	const query = localWindow.queryLocalFonts;
	const operation = useOperation(async (query: NonNullable<LocalFontWindow["queryLocalFonts"]>) => {
		try {
			const available = await query.call(window);
			return [...new Set(available.map((font) => font.family))].sort((a, b) => a.localeCompare(b));
		} catch (error) {
			throw new Error(error instanceof DOMException && error.name === "NotAllowedError"
				? "未获字体访问权限，仍可手写字体名。"
				: "无法读取本机字体，请重试或手写字体名。");
		}
	}, setFonts);
	const empty = operation.state.state === "succeeded" && operation.state.value.length === 0;
	return {
		fonts, loading: operation.pending, supported: query !== undefined,
		error: operation.error || (empty ? "未获得本机字体列表，仍可手写字体名。" : ""),
		load: () => { if (query) operation.run(query); },
	};
}
