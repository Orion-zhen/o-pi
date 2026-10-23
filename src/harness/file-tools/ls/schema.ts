import { Type } from "typebox";

export const lsParameters = Type.Object(
	{ path: Type.Optional(Type.String({ minLength: 1, description: "Directory; default workspace." })) },
	{ additionalProperties: false },
);
