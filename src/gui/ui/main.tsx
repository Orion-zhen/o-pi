import { createRoot } from "react-dom/client";
import { App } from "./app/app.tsx";
import { applyThemeColor } from "./preferences/apply.ts";
import { DEFAULT_THEME_COLOR } from "./preferences/palette.ts";
import "./preferences/theme.css";
import "./app/style.css";
import "./composer/composer.css";
import "./transcript/transcript.css";
import "./tools/tools.css";
import "./tools/rich-tools.css";
import "./content/code.css";
import "./app/motion.css";
import "./app/layout.css";

document.title = window.opi ? "opi-desktop" : "opi-web";
applyThemeColor(DEFAULT_THEME_COLOR);
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
