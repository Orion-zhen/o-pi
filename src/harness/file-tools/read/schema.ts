import { Type } from "typebox";
import { READ_RANGE_PATTERN } from "../../content-ranges.ts";

export const readParameters = Type.Object(
	{
		path: Type.String({ description: "Text, image or PDF file path." }),
		lines: Type.Optional(Type.String({
			minLength: 1,
			pattern: READ_RANGE_PATTERN,
			description: "Text line ranges: N, N-M, or N-, supports multiple comma-separated ranges; 1-based inclusive.",
		})),
		pages: Type.Optional(Type.String({
			minLength: 1,
			pattern: READ_RANGE_PATTERN,
			description: "PDF page ranges: N, N-M, or N-, supports multiple comma-separated ranges; 1-based inclusive.",
		})),
	},
	{ additionalProperties: false },
);
