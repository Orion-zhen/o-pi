import { Type } from "typebox";

export const editParameters = Type.Object(
	{
		path: Type.String({ description: "Previously read or written file." }),
		edits: Type.Array(Type.Object({
			old: Type.String({
				minLength: 1,
				description: "Exact text in original content. Must be unique unless replace_all is true.",
			}),
			new: Type.String(),
			replace_all: Type.Optional(Type.Boolean({ default: false, description: "Replace ALL old matches." })),
		}, { additionalProperties: false }), {
			minItems: 1,
			description: "Non-overlapping replacements against original content.",
		}),
	},
	{ additionalProperties: false },
);
