import { Fragment } from "react";
import type { SearchExcerpt } from "../../../shared/session-search.ts";

export function SearchExcerptText({ value, label = "" }: { value: SearchExcerpt; label?: string }) {
	const start = value.ranges[0][0];
	const prefix = (label + value.text.slice(0, start)).replace(/\s+$/u, "\u00a0");
	let previous = start;
	return <span className="search-excerpt">
		{prefix && <span className="search-excerpt-prefix">{prefix}</span>}
		<span className="search-excerpt-match">{value.ranges.map(([start, end]) => {
			const prefix = value.text.slice(previous, start);
			previous = end;
			return <Fragment key={`${start}:${end}`}>{prefix}<mark>{value.text.slice(start, end)}</mark></Fragment>;
		})}{value.text.slice(previous)}</span>
	</span>;
}
