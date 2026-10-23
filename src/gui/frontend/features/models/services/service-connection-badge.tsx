import { LoaderCircle } from "lucide";
import { MorphIcon } from "morphicons/react";
import { StatusDot } from "@/ui/icon-shapes.ts";
import type { ModelServiceConnection } from "../../../../shared/config/model-services.ts";
import { serviceConnectionTimeoutMs } from "../../../../../harness/openai-compatible-provider/service-connection.ts";
import { Hint } from "@/ui/tooltip.tsx";

export type ServiceConnectionState = ModelServiceConnection | { status: "unchecked" | "checking" | "unsaved" | "reload-required" | "check-failed" };
const states: Record<ServiceConnectionState["status"], { label: string; tone: string; detail: string }> = {
	unchecked: { label: "未检测", tone: "muted", detail: "选择有效会话后检测已生效的配置。" },
	checking: { label: "检测中", tone: "muted", detail: "正在读取当前会话配置的 /models 接口。" },
	unsaved: { label: "待保存", tone: "muted", detail: "连接配置已修改，请先保存并重载当前会话。" },
	"reload-required": { label: "待重载", tone: "muted", detail: "请重载当前会话，再检测新连接配置。" },
	unavailable: { label: "未检测", tone: "muted", detail: "当前会话尚无可检测的服务地址。" },
	unconfigured: { label: "未配置认证", tone: "muted", detail: "请先配置当前会话的服务认证。" },
	connected: { label: "已连接", tone: "success", detail: "已成功读取模型列表。" },
	"auth-failed": { label: "认证失败", tone: "error", detail: "无法解析认证，或服务拒绝了当前凭据。" },
	"network-error": { label: "连接失败", tone: "error", detail: "无法连接 API，请检查地址、网络和证书。" },
	timeout: { label: "连接超时", tone: "error", detail: `检测未在 ${serviceConnectionTimeoutMs / 1000} 秒内完成。` },
	"server-error": { label: "服务异常", tone: "error", detail: "服务返回了服务器错误。" },
	"rate-limited": { label: "限流", tone: "warning", detail: "服务限制了请求，请稍后重试。" },
	unsupported: { label: "无法验证", tone: "warning", detail: "服务不支持当前 /models 路径，不代表聊天接口不可用。" },
	"invalid-response": { label: "无法验证", tone: "warning", detail: "响应不是有效的模型列表，无法验证 API 连接。" },
	"http-error": { label: "请求失败", tone: "error", detail: "服务拒绝了模型列表请求。" },
	"check-failed": { label: "检测失败", tone: "warning", detail: "无法完成检测，请稍后重试。" },
};

export function ServiceConnectionBadge({ id, connection, disabled, retry }: {
	id: string;
	connection: ServiceConnectionState;
	disabled: boolean;
	retry: () => Promise<void>;
}) {
	const { label, tone, detail } = states[connection.status];
	const checking = connection.status === "checking";
	const lines = [detail];
	if ("checkedAt" in connection) {
		if (connection.httpStatus !== null) lines.push(`HTTP 状态：${connection.httpStatus}`);
		lines.push(`耗时：${connection.latencyMs} ms`, `检测时间：${new Date(connection.checkedAt).toLocaleString("zh-CN")}`);
	}
	if (!disabled) lines.push("点击重新检测。");
	return <Hint content={lines.join("\n")}>
		<button type="button" className="service-connection" data-tone={tone} aria-label={`检测服务 ${id}，${label}`}
			aria-disabled={disabled} aria-busy={checking} onClick={() => { void retry(); }}>
			<MorphIcon icon={checking ? LoaderCircle : StatusDot} spring="smooth" size="1em" className={checking ? "animate-spin" : undefined} />
			<span aria-live="polite">{label}</span>
		</button>
	</Hint>;
}
