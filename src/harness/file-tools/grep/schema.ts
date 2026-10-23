import { Type } from "typebox";

export const grepParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Case-sensitive line query." }),
		mode: Type.Optional(Type.Union([Type.Literal("regex"), Type.Literal("literal")], {
			default: "regex",
			description: "ECMAScript regex or exact text.",
		})),
		path: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			description: "File or directory scopes; OR/union scope; default workspace.",
		})),
		glob: Type.Optional(Type.String({
			minLength: 1,
			description: "Relative to each scope; without / matches basenames recursively; use a path pattern such as src/**/*.ts for scoped paths.",
		})),
	},
	{ additionalProperties: false },
);
