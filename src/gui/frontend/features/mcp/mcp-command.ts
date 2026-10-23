/** 只拆分程序和参数，不执行 shell，也不展开变量或操作符。 */
export function parseMcpCommand(text: string): { command: string; args: string[] } {
	const tokens: string[] = [];
	let token = "", quote = "", started = false;
	for (let index = 0; index < text.length; index++) {
		const char = text.charAt(index);
		if (quote === "'") {
			if (char === "'") quote = ""; else token += char;
			continue;
		}
		if (char === "$" || char === "`") throw new Error("不支持 shell 展开，请使用参数列表填写字面值。");
		if (char === "\\") {
			const next = text[index + 1];
			if (next === undefined || next === "\n" || next === "\r") throw new Error("不支持未完成的转义或多行命令。");
			if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) token += "\\";
			else { token += next; index++; }
			started = true;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = ""; else token += char;
			continue;
		}
		if (/[|;&<>\r\n]/.test(char)) throw new Error("仅支持单个启动命令，不支持管道、重定向或多行命令。");
		if (char === "'" || char === '"') { quote = char; started = true; }
		else if (/\s/.test(char)) {
			if (started) { tokens.push(token); token = ""; started = false; }
		} else { token += char; started = true; }
	}
	if (quote) throw new Error("引号未闭合。");
	if (started) tokens.push(token);
	const [command, ...args] = tokens;
	if (!command) throw new Error("请输入启动命令。");
	if (/^[A-Za-z_]\w*=/.test(command)) throw new Error("请将环境变量填写在环境变量列表中。");
	return { command, args };
}
