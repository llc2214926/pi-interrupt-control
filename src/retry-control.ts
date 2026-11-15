import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DELAY_MS, retryFirst } from "./retry-stream.ts";

const DEFAULT_SETTINGS = { retries: 3, delayMs: DEFAULT_DELAY_MS };

export function registerRetryControl(pi: ExtensionAPI) {
	let restore: (() => void) | undefined;
	const settingsBySession = new Map<string, typeof DEFAULT_SETTINGS>();

	pi.registerCommand("set-retry", {
		description: "设置额外重试次数（-100–100）及间隔，如 /set-retry 10 5s；默认 3 秒，负数耗尽停止",
		handler: async (args, ctx) => {
			const id = ctx.sessionManager.getSessionId();
			const value = args.trim();
			if (value) {
				const match = /^(-?\d+)(?:\s+(\d+(?:\.\d+)?)s)?$/.exec(value);
				const retries = Number(match?.[1]);
				const delayMs = match?.[2] === undefined ? DEFAULT_DELAY_MS : Number(match[2]) * 1000;
				if (!match || !Number.isInteger(retries) || Math.abs(retries) > 100 || !Number.isFinite(delayMs) || delayMs < 1 || delayMs > 2147483647) {
					ctx.ui.notify("用法：/set-retry <-100–100 的整数> [间隔秒数s]，例如 /set-retry 10 5s；未改变当前设置", "warning");
					return;
				}
				settingsBySession.set(id, { retries, delayMs });
			}
			const { retries, delayMs } = settingsBySession.get(id) ?? DEFAULT_SETTINGS;
			const status = `本次会话额外重试次数：${Math.abs(retries)}；${retries < 0 ? "耗尽后直接停止" : "耗尽后交给 pi 原有逻辑"}；间隔 ${delayMs / 1000}s`;
			ctx.ui.notify(ctx.mode === "tui" ? `\x1b[1;95m${status}\x1b[0m` : status, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		restore?.();
		const id = ctx.sessionManager.getSessionId();
		// SAFETY: 宿主将 runtime 存为实例字段；下方验证方法存在，并用 sessionId + signal 限定主请求。
		const runtime = (ctx.modelRegistry as unknown as { runtime?: { streamSimple: StreamFn } }).runtime;
		if (!runtime || typeof runtime.streamSimple !== "function") {
			throw new Error("pi-interrupt-control：无法访问 ModelRegistry.runtime.streamSimple，当前 Pi 不兼容，未启用优先重试");
		}
		const original = runtime.streamSimple;
		let active = true;
		let requestNumber = 0;
		const pendingWarnings = new Set<(summarize?: boolean) => void>();
		const wrapped: StreamFn = (model, context, options) => {
			// 排除其他会话、压缩/摘要、缓存预热及没有主请求 signal 的嵌套调用。
			if (!active || options?.sessionId !== id || !options.signal || options.signal !== ctx.signal) {
				return original.call(runtime, model, context, options);
			}
			const widgetKey = `pi-interrupt-control:retry:${id}:${++requestNumber}`;
			let retryCount = 0;
			const finishWarnings = (summarize = true) => {
				pendingWarnings.delete(finishWarnings);
				if (retryCount === 0 || !active) return;
				ctx.ui.setWidget(widgetKey, undefined);
				if (summarize) ctx.ui.notify(`模型请求失败，重试${retryCount}次`, "warning");
				retryCount = 0;
			};
			pendingWarnings.add(finishWarnings);
			const { retries, delayMs } = settingsBySession.get(id) ?? DEFAULT_SETTINGS;
			const retrying = retryFirst(original.bind(runtime), (attempt, maxRetries) => {
				if (!active) return;
				retryCount = attempt;
				const line = `Warning: 模型请求失败，先重试 ${attempt}/${maxRetries}`;
				// 临时区只显示最新一次重试，结束时清除后只留总结。
				ctx.ui.setWidget(widgetKey, [ctx.mode === "tui" ? ctx.ui.theme.fg("warning", line) : line]);
			}, () => retries, (error, maxRetries) => {
				if (!active) return;
				finishWarnings();
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`额外重试 ${maxRetries} 次后仍失败，已停止，不触发供应商切换：${detail}`, "error");
				// 只发起 abort；在流内部等待 agent 收尾会死锁。
				ctx.abort();
			}, () => delayMs);
			const stream = retrying(model, context, options);
			// result() 不消费事件；取消只清理提示，不留下重试总结。
			void Promise.resolve(stream).then((response) => response.result()).then(
				() => finishWarnings(!options.signal?.aborted),
				() => finishWarnings(false),
			);
			return stream;
		};
		runtime.streamSimple = wrapped;
		restore = () => {
			for (const finish of pendingWarnings) finish(false);
			// 即使其他扩展后来包裹了本层，也不再访问已失效的 ctx。
			active = false;
			if (runtime.streamSimple === wrapped) runtime.streamSimple = original;
		};
	});

	pi.on("session_shutdown", () => restore?.());
}
