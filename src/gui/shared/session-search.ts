export interface SearchExcerpt {
	text: string;
	/** 原文 UTF-16 半开区间，可直接用于 slice。 */
	ranges: [[number, number], ...[number, number][]];
}

export interface SessionSearchHit {
	path: string;
	source: "title" | "user" | "assistant";
	excerpt: SearchExcerpt;
}

export interface SessionSearchPage {
	id: string;
	hits: SessionSearchHit[];
	scanned: number;
	total: number;
	done: boolean;
}
