import path from "node:path";
import { fileURLToPath } from "node:url";

/** 必须先于 Pi 配置和 SDK 加载，供桌面后端及打包入口共同初始化。 */
export const directory = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_OPI_RESOURCE_DIR = path.join(directory, "resources");
process.env.PI_PACKAGE_DIR = path.join(directory, "resources", "pi");
