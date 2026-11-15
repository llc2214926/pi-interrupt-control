import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { FileEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

// 历史文件及模型错误中的控制字符不能直接进入终端。
export function label(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function errorText(error: unknown): string {
  return label(error instanceof Error ? error.message : String(error));
}

export function readRegular(path: string): Buffer {
  const limit = 256 * 1024 * 1024;
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error(`不是普通文件（不操作符号链接）：${path}`);
  if (before.size > limit) throw new Error(`文件超过 256 MiB 安全上限：${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) {
      throw new Error(`读取时文件被替换：${path}`);
    }
    if (opened.size > limit) throw new Error(`文件超过 256 MiB 安全上限：${path}`);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error(`读取时文件被截断：${path}`);
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw new Error(`读取时文件增长：${path}`);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (after.size !== bytes.length || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs || current.ino !== after.ino || current.dev !== after.dev || current.isSymbolicLink()) {
      throw new Error(`读取时文件被修改：${path}`);
    }
    return bytes;
  } finally { closeSync(fd); }
}

function validContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every((part) => {
    if (!part || typeof part !== "object" || typeof part.type !== "string") return false;
    switch (part.type) {
      case "text": return typeof part.text === "string";
      case "image": return typeof part.data === "string" && typeof part.mimeType === "string";
      case "thinking": return typeof part.thinking === "string";
      case "toolCall": return typeof part.id === "string" && typeof part.name === "string" &&
        !!part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments);
      default: return true; // 保留宿主/扩展新增的内容块，不改写其原始数据。
    }
  });
}

function validPayload(entry: FileEntry, version: number, ids: Set<string>): boolean {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (!message || typeof message !== "object" || typeof message.role !== "string") return false;
      if (message.role === "bashExecution") {
        return typeof message.command === "string" && typeof message.output === "string";
      }
      if (["user", "assistant", "system", "toolResult", "custom", "hookMessage"].includes(message.role)) {
        return "content" in message && validContent(message.content) &&
          (!["assistant", "toolResult"].includes(message.role) || Array.isArray(message.content));
      }
      return true;
    }
    case "context_edit":
      return typeof entry.targetId === "string" && ids.has(entry.targetId) &&
        (entry.replacement === null || (!!entry.replacement && validContent(entry.replacement.content)));
    case "session_info": return entry.name === undefined || typeof entry.name === "string";
    case "custom_message":
      return typeof entry.customType === "string" && typeof entry.display === "boolean" && validContent(entry.content);
    case "custom": return typeof entry.customType === "string";
    case "compaction":
      return typeof entry.summary === "string" && Number.isFinite(entry.tokensBefore) &&
        ((typeof entry.firstKeptEntryId === "string" && (ids.has(entry.firstKeptEntryId) || entry.firstKeptEntryId === entry.id)) ||
          (version === 1 && "firstKeptEntryIndex" in entry && Number.isInteger(entry.firstKeptEntryIndex)));
    case "branch_summary":
      return typeof entry.summary === "string" && (entry.fromId === null || typeof entry.fromId === "string");
    case "label":
      return typeof entry.targetId === "string" && ids.has(entry.targetId) &&
        (entry.label === undefined || typeof entry.label === "string");
    case "model_change": return typeof entry.provider === "string" && typeof entry.modelId === "string";
    case "thinking_level_change": return typeof entry.thinkingLevel === "string";
    case "usage":
      return typeof entry.kind === "string" && typeof entry.provider === "string" && typeof entry.model === "string" &&
        !!entry.usage && typeof entry.usage === "object" && !!entry.usage.cost && typeof entry.usage.cost === "object";
    default: return true;
  }
}

// 不静默丢弃损坏行，避免生成看似完整、实际缺失关键约束的交接。
export function parseSession(text: string): { header: SessionHeader; entries: FileEntry[] } {
  let entries: FileEntry[];
  try {
    entries = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`会话含损坏的 JSON 行：${errorText(error)}`);
  }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id ||
      typeof header.cwd !== "string" || !isAbsolute(header.cwd) || header.cwd.includes("\0") ||
      typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp)) ||
      (header.parentSession !== undefined && (typeof header.parentSession !== "string" ||
        !isAbsolute(header.parentSession) || header.parentSession.includes("\0"))) ||
      (header.version !== undefined && ![1, 2, 3].includes(header.version))) {
    throw new Error("无效或不支持的 Pi 会话头");
  }
  const ids = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (!entry || entry.type === "session" || typeof entry.type !== "string") {
      throw new Error("会话含无效条目");
    }
    const version = header.version ?? 1;
    if (version >= 2 && (typeof entry.id !== "string" || !entry.id || ids.has(entry.id) ||
        (entry.parentId !== null && !ids.has(entry.parentId)))) {
      throw new Error("会话树存在重复 ID、断链或循环");
    }
    if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp)) ||
        !validPayload(entry, version, ids)) {
      throw new Error(`会话含无效 ${label(entry.type)} 条目：缺少或损坏的必要字段`);
    }
    if (version >= 2) ids.add(entry.id);
  }
  return { header, entries };
}
