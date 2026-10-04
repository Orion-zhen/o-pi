import { materialRegions, type GuiMaterials } from "../../preferences.ts";

let saved: GuiMaterials | undefined;
let preview: GuiMaterials | undefined;

export function applyMaterials(value: GuiMaterials): void {
	saved = value;
	if (!preview) renderMaterials(value);
}

/** 配置刷新只更新底稿，未保存的预览在放弃或关闭后才撤销。 */
export function previewMaterials(value: GuiMaterials): () => void {
	preview = value;
	renderMaterials(value);
	return () => {
		preview = undefined;
		if (saved) renderMaterials(saved);
	};
}

function renderMaterials(value: GuiMaterials): void {
	const root = document.documentElement;
	root.dataset.desktopTransparent = String(value.enabled && value.desktop);
	root.style.setProperty("--material-transparency", value.enabled ? "1" : "0");
	if (value.enabled) root.style.removeProperty("--material-filter-override");
	else root.style.setProperty("--material-filter-override", "none");
	for (const region of materialRegions) {
		const surface = value[region];
		root.style.setProperty(`--material-${region}-opacity`, `${surface.opacity}%`);
		root.style.setProperty(`--material-${region}-dark-opacity`, `${surface.darkOpacity}%`);
		root.style.setProperty(`--material-${region}-filter`, `blur(${surface.blur}px) saturate(${surface.saturation}%)`);
	}
}
