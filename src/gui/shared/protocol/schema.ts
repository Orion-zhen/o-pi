import { Type, type TProperties } from "typebox";
import { moduleConfigIds } from "../config/modules.ts";

export const moduleConfigId = Type.Enum(moduleConfigIds);
export const text = Type.String();
export const short = Type.String({ maxLength: 4096 });
export const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
