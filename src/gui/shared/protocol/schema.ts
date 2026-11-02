import { oneOf, str } from "@earendil-works/pi-schema";
import { moduleConfigIds } from "../config/modules.ts";

export { obj as object } from "@earendil-works/pi-schema";
export const moduleConfigId = oneOf(moduleConfigIds);
export const text = str();
export const short = str({ maxLength: 4096 });
