import { Command, InvalidArgumentError } from "commander";

interface WebOptions {
	host: string;
	port: number;
	cwd: string;
	cert?: string;
	key?: string;
}

function parsePort(value: string): number {
	const port = Number(value);
	if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65535) {
		throw new InvalidArgumentError("端口必须是 0-65535 的十进制整数。");
	}
	return port;
}

export function parseWebArgs(args: readonly string[]): WebOptions {
	const command = new Command("opi-web")
		.description("启动 WebUI")
		.option("--host <IP>", "监听地址", "0.0.0.0")
		.option("-p, --port <PORT>", "监听端口，0 表示自动分配", parsePort, 19198)
		.option("--cwd <PATH>", "工作目录", process.cwd())
		.option("--cert <FILE>", "TLS 证书，须同时指定 --key")
		.option("--key <FILE>", "TLS 私钥，须同时指定 --cert")
		.helpOption("-h, --help", "显示帮助")
		.addHelpText("after", "\n免登录，仅用于可信局域网，请勿暴露到公网。TLS 证书可选。")
		.showHelpAfterError("使用 opi-web --help 查看帮助。");
	command.parse(args, { from: "user" });
	const options = command.opts<WebOptions>();
	if ((options.cert !== undefined) !== (options.key !== undefined)) {
		command.error("--cert 和 --key 必须同时指定。");
	}
	if (options.cert === "" || options.key === "") {
		command.error("TLS 文件路径不能为空。");
	}
	return options;
}
