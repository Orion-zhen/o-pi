import { Type } from "typebox";

export const writeParameters = Type.Object(
	{
		path: Type.String({ minLength: 1, description: "Destination path." }),
		content: Type.String(),
	},
	{ additionalProperties: false },
);
