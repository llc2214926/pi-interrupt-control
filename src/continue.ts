import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_PROMPT = `Continue.

MUST resume most recent intent; complete unfinished work.
If interrupted mid-step: resume where stopped.
NEVER pause to summarize progress, re-confirm plan, or ask whether to proceed; continue.`;

export function registerContinueInput(pi: ExtensionAPI) {
	pi.on("input", (event) => {
		const text = event.text.trim();
		if (event.source === "extension" || event.images?.length || (text !== "。" && text !== ".")) {
			return { action: "continue" };
		}

		pi.sendMessage(
			{
				// 保留原消息类型，兼容已有会话记录。
				customType: "dot-continue",
				content: CONTINUE_PROMPT,
				display: false,
				details: undefined,
			},
			// nextTurn 不主动启动下一轮；followUp 在空闲时启动，运行中排队。
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return { action: "handled" };
	});
}
