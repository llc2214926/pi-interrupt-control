import { setTimeout as sleep } from "node:timers/promises";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

export const DEFAULT_DELAY_MS = 3000;

/** 每个主请求先独立重试，再交给 Pi 的错误分类、压缩或其他回退扩展。 */
export function retryFirst(
	base: StreamFn,
	onRetry: (attempt: number, maxRetries: number) => void,
	getRetries: () => number,
	onExhausted: (error: unknown, maxRetries: number) => void,
	getDelayMs: () => number = () => DEFAULT_DELAY_MS,
): StreamFn {
	return (model, context, options) => {
		const retries = getRetries();
		const maxRetries = Math.abs(retries);
		const delayMs = getDelayMs();
		const output = createAssistantMessageEventStream();
		const run = async () => {
			for (let attempt = 0; ; attempt++) {
				if (attempt > 0) await sleep(delayMs, undefined, { signal: options?.signal });
				let message: AssistantMessage;
				let errorEvent = false;
				try {
					options?.signal?.throwIfAborted();
					const source = await base(model, context, options);
					// 缓存整次响应，不让失败尝试的文本或工具参数进入 agent loop。
					for await (const event of source) {
						options?.signal?.throwIfAborted();
						if (event.type === "error") errorEvent = true;
					}
					message = await source.result();
					options?.signal?.throwIfAborted();
					if (message.stopReason === "pending") throw new Error("模型响应未正常结束");
				} catch (error) {
					if (options?.signal?.aborted) throw error;
					if (attempt >= maxRetries) {
						if (retries < 0) onExhausted(error, maxRetries);
						throw error;
					}
					onRetry(attempt + 1, maxRetries);
					continue;
				}

				const failed = errorEvent || message.stopReason === "error" || message.stopReason === "aborted" || !!message.errorMessage;
				if (failed && attempt < maxRetries) {
					onRetry(attempt + 1, maxRetries);
					continue;
				}
				if (failed) {
					if (retries < 0) onExhausted(message.errorMessage || "模型请求失败", maxRetries);
					message = {
						...message,
						// 失败响应不能留下没有对应结果的工具调用。
						content: message.content.filter((block) => block.type !== "toolCall"),
						stopReason: options?.signal?.aborted || message.stopReason === "aborted" ? "aborted" : "error",
						errorMessage: message.errorMessage || "模型请求失败",
					};
				}

				// 按 Pi 的事件协议回放被接受的响应，保留完整的工具调用结束标记。
				const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
				output.push({ type: "start", partial });
				for (const block of message.content) {
					const contentIndex = partial.content.length;
					if (block.type === "text") {
						const current = { ...block, text: "" };
						partial.content.push(current);
						output.push({ type: "text_start", contentIndex, partial });
						current.text = block.text;
						output.push({ type: "text_delta", contentIndex, delta: block.text, partial });
						output.push({ type: "text_end", contentIndex, content: block.text, partial });
					} else if (block.type === "thinking") {
						const current = { ...block, thinking: "" };
						partial.content.push(current);
						output.push({ type: "thinking_start", contentIndex, partial });
						current.thinking = block.thinking;
						output.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
						output.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
					} else {
						const current = { ...block, arguments: {} };
						partial.content.push(current);
						output.push({ type: "toolcall_start", contentIndex, partial });
						current.arguments = block.arguments;
						output.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
						output.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
					}
				}
				if (message.stopReason === "pending") throw new Error("模型响应未正常结束");
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					output.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					output.push({ type: "done", reason: message.stopReason, message });
				}
				output.end();
				return;
			}
		};
		void run().catch((error) => {
			// 事件流没有 fail()；请求异常也必须编码成终止事件。
			const message: AssistantMessage = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: options?.signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
			output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			output.end();
		});
		return output;
	};
}
