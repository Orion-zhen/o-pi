import { Type } from "typebox";

export const findParameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			maxLength: 512,
			description: "fzf query: spaces AND; | OR; ' exact; ^ prefix; $ suffix; ! inverse.",
		}),
		path: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			description: "Search roots; OR/union scope; default workspace.",
		})),
		glob: Type.Optional(Type.String({ minLength: 1, description: "Candidate path glob relative to each scope." })),
	},
	{ additionalProperties: false },
);
