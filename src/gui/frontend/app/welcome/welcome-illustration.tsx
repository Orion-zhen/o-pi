import { memo, useId, useMemo } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
// 资产由 bun run generate:welcome 生成，编辑入口见 assets/welcome/README.md。
import hair from "./art/hair.json";
import face from "./art/face-neck.json";
import collar from "./art/collar.json";
import body from "./art/body.json";
import leftSleeve from "./art/left-sleeve.json";
import rightSleeve from "./art/right-sleeve.json";
import leftHand from "./art/left-hand.json";
import rightHand from "./art/right-hand.json";
import guides from "./art/reveal.json";
import { welcomeDuration, welcomeLogoDuration, welcomeLogoStart } from "./welcome-timing.ts";
import { createWindPath } from "./welcome-wind-path.ts";
import type { WindLayer } from "./welcome-wind.ts";

const layers = [hair, face, collar, body, leftSleeve, rightSleeve, leftHand, rightHand];
// 按比例压缩原有笔画时序，保留从上往下的勾勒顺序。
const drawScale = welcomeLogoStart / Math.max(...guides.map((guide) => guide.start + guide.duration));
type Paint = typeof hair.paints[number];

// 两个姿态保留相同的路径指令，手腕与衣袖沿同一变形场连续移动。
const Paint = memo(function Paint({ paint, pose }: { paint: Paint; pose: MotionValue<number> }) {
	const d = useTransform(pose, [0, 1], [paint.d, paint.offer]);
	return <motion.path fillOpacity={paint.opacity} style={{ d }} />;
});

const WindPaint = memo(function WindPaint({ paint, layer, pose, windTime, windAmount }: {
	paint: Paint; layer: WindLayer; pose: MotionValue<number>; windTime: MotionValue<number>; windAmount: MotionValue<number>;
}) {
	const offer = useTransform(pose, [0, 1], [paint.d, paint.offer]);
	const wind = useMemo(() => createWindPath(paint.d, layer), [paint.d, layer]);
	const d = useTransform(() => {
		// Motion 在渲染时收集依赖，两个动作的输入都必须订阅。
		const amount = windAmount.get(), time = windTime.get(), offered = offer.get();
		return amount === 0 ? offered : wind(time, amount);
	});
	return <motion.path fillOpacity={paint.opacity} style={{ d }} />;
});

function Guide({ guide, time }: { guide: typeof guides[number]; time: MotionValue<number> }) {
	const start = guide.start * drawScale;
	const length = useTransform(time, [start, start + guide.duration * drawScale], [0, 1]);
	const opacity = useTransform(time, [start, start + 0.07 * drawScale], [0, 1]);
	return <motion.path d={guide.d} strokeWidth={guide.width} style={{ pathLength: length, opacity }} />;
}

export const WelcomeIllustration = memo(function WelcomeIllustration({ time, pose, windTime, windAmount, complete }: {
	time: MotionValue<number>; pose: MotionValue<number>; windTime: MotionValue<number>; windAmount: MotionValue<number>; complete: boolean;
}) {
	const id = useId();
	const handX = useTransform(pose, [0, 1], [0, leftHand.offer.x]);
	const handY = useTransform(pose, [0, 1], [0, leftHand.offer.y]);
	const logoOpacity = useTransform(time, [welcomeLogoStart, welcomeDuration], [0, 0.86]);
	const logoY = useTransform(() => Math.max(0, (welcomeDuration - time.get()) / welcomeLogoDuration) * 14 - pose.get() * 18);
	return <svg className="welcome-illustration" viewBox="420 24 680 730" role="img" aria-label="少女捧起 opi 图标">
		<defs>
			{!complete && <mask id={`${id}-draw`} maskUnits="userSpaceOnUse" x="420" y="24" width="680" height="730" style={{ maskType: "alpha" }}>
				<g fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round">
					{guides.map((guide, index) => <Guide key={index} guide={guide} time={time} />)}
				</g>
			</mask>}
			<mask id={`${id}-brand`} maskUnits="userSpaceOnUse" x="714" y="540" width="118" height="118" style={{ maskType: "alpha" }}>
				<image href="./logo.svg" x="714" y="540" width="118" height="118" />
			</mask>
		</defs>
		<g fill="currentColor" mask={complete ? undefined : `url(#${id}-draw)`}>
			{layers.map((layer) => "offer" in layer
				? <motion.g key={layer.id} data-layer={layer.id} style={{ x: handX, y: handY }}>
					{layer.paints.map((paint, band) => <path key={band} d={paint.d} fillOpacity={paint.opacity} />)}
				</motion.g>
				: <g key={layer.id} data-layer={layer.id}>
					{layer.paints.map((paint, band) => layer.id === "hair" || layer.id === "left-sleeve" || layer.id === "right-sleeve"
						? <WindPaint key={band} paint={paint} layer={layer.id} pose={pose} windTime={windTime} windAmount={windAmount} />
						: <Paint key={band} paint={paint} pose={pose} />)}
				</g>)}
		</g>
		<motion.g style={{ opacity: logoOpacity, y: logoY }}>
			<rect x="714" y="540" width="118" height="118" fill="currentColor" mask={`url(#${id}-brand)`} />
		</motion.g>
	</svg>;
});
