import { createContext, useContext } from "react";
import type { Query } from "../../shared/protocol/queries.ts";

export const GuiQueryContext = createContext<Query | undefined>(undefined);

export function useGuiQuery(): Query {
	const query = useContext(GuiQueryContext);
	if (!query) throw new Error("缺少 GUI 查询上下文。");
	return query;
}
