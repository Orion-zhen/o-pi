import { mix } from "motion/react";
import { windDuration, windFrame, windStep, type WindLayer } from "./welcome-wind.ts";

/** 只保留相邻采样帧，避免欢迎页挂载时生成全部路径和插值器。 */
export function createWindPath(d: string, layer: WindLayer) {
	let frame = -1;
	let next = d;
	let tween: (progress: number) => string = () => d;
	let returnTime = -1;
	let returning: (amount: number) => string = () => d;
	return (time: number, amount: number): string => {
		if (amount === 0 || time === 0 || time >= windDuration) return d;
		const index = Math.floor(time / windStep);
		if (index !== frame) {
			const from = index === frame + 1 ? next : windFrame(d, layer, index * windStep);
			next = windFrame(d, layer, (index + 1) * windStep);
			tween = mix(from, next);
			frame = index;
		}
		const progress = (time - index * windStep) / windStep;
		if (amount === 1) return tween(progress);
		// 中断时冻结风的时间，仅从当前轮廓柔和归位，不倒放整段动作。
		if (returnTime !== time) {
			returning = mix(d, tween(progress));
			returnTime = time;
		}
		return returning(amount);
	};
}
