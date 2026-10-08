import { Type } from "typebox";

const image = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });

export const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ ...image.properties, note: Type.String() }),
	Type.Object({
		type: Type.Literal("pdf"),
		content: Type.Array(Type.Union([Type.Object({ type: Type.Literal("text"), text: Type.String() }), image])),
	}),
]);
