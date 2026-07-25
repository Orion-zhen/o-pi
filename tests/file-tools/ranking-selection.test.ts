import { describe, expect, it } from "vitest";

import { selectRelevanceHeadMmr } from "../../src/file-tools/shared/ranking/selection.js";

interface Candidate {
	id: string;
	group: string;
	tier: number;
	rank: number;
	score: number;
}

const compare = (left: Candidate, right: Candidate): number => left.tier - right.tier || left.rank - right.rank || left.id.localeCompare(right.id);
const options = {
	compare,
	tier: (candidate: Candidate) => candidate.tier,
	score: (candidate: Candidate) => candidate.score,
	identity: (candidate: Candidate) => candidate.id,
	similarity: (left: Candidate, right: Candidate) => left.group === right.group ? 0.8 : 0,
};

function candidate(id: string, rank: number, group = id, tier = 1, score = 1): Candidate {
	return { id, rank, group, tier, score };
}

describe("ranking selection", () => {
	it("limit=1 始终返回全局最相关候选", () => {
		const input = [candidate("c", 3), candidate("a", 1), candidate("b", 2)];
		expect(selectRelevanceHeadMmr(input, 1, options).map((item) => item.id)).toEqual(["a"]);
	});

	it("前三名保持 relevance 顺序且多样性只影响尾部", () => {
		const input = [
			candidate("a", 1, "same"), candidate("b", 2, "same"), candidate("c", 3, "same"),
			candidate("d", 4, "same"), candidate("e", 5, "other"), candidate("f", 6, "third"),
		];
		const selected = selectRelevanceHeadMmr(input, 5, options);
		expect(selected.slice(0, 3).map((item) => item.id)).toEqual(["a", "b", "c"]);
		expect(selected.map((item) => item.id)).toContain("e");
	});

	it("较差 tier 不会因多样性越过更好 tier", () => {
		const input = [
			candidate("a", 1, "same", 1), candidate("b", 2, "same", 1), candidate("c", 3, "same", 1),
			candidate("d", 4, "same", 1), candidate("diverse", 1, "other", 2),
		];
		expect(selectRelevanceHeadMmr(input, 4, options).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("同 tier 的明显低质量尾项被动态 cutoff 丢弃", () => {
		const input = [candidate("a", 1, "a", 1, 1), candidate("b", 2, "b", 1, 0.29)];
		expect(selectRelevanceHeadMmr(input, 2, options).map((item) => item.id)).toEqual(["a"]);
	});

	it("空输入和非正限制返回空结果", () => {
		expect(selectRelevanceHeadMmr([], 4, options)).toEqual([]);
		expect(selectRelevanceHeadMmr([candidate("a", 1)], 0, options)).toEqual([]);
	});
});
