import { isPromptCachePersistent } from "@oh-my-pi/pi-catalog/compat/prompt-cache-persistent";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { observedPromptCacheTier, resolvePromptCacheTier } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

export interface PromptCacheInfo {
	/** 缓存到期时刻；undefined 表示供应商常驻保存。 */
	expiresAt?: number;
	ttlSeconds?: number;
	/** 换了模型、压缩过或暖机落空：下一则消息读不到缓存。 */
	stale: boolean;
}

/** 照 OMP 状态栏 `cache` 的推算：分支上最新一则用到缓存的回复，加上其后暖机命中的刷新时刻。 */
export function promptCacheInfo(
	branch: readonly SessionEntry[],
	registry: Pick<ModelRegistry, "find" | "isUsingOAuth">,
	current: Model<Api> | undefined,
): PromptCacheInfo | undefined {
	let reply: AssistantMessage | undefined;
	let touchedAt = 0;
	let missed = false;
	let compacted = false;
	for (const entry of branch) {
		if (entry.type === "reset_boundary") reply = undefined;
		else if (entry.type === "compaction") compacted = true;
		else if (entry.type === "model_usage" && entry.cacheRefresh && reply) {
			missed = !entry.cacheRefresh.hit && entry.usage.cacheWrite <= 0;
			if (!missed) touchedAt = Math.max(touchedAt, entry.cacheRefresh.sentAt);
		} else if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason !== "error" &&
			entry.message.usage.cacheRead + entry.message.usage.cacheWrite > 0
		) {
			reply = entry.message;
			touchedAt = reply.timestamp;
			missed = false;
			compacted = false;
		}
	}
	if (!reply) return undefined;
	const model = registry.find(reply.provider, reply.model);
	if (!model) return undefined;
	const stale = missed || compacted || current?.provider !== model.provider || current.id !== model.id;
	if (isPromptCachePersistent(model)) return { stale };
	const isOAuth = model.api === "anthropic-messages" && registry.isUsingOAuth(model);
	const tier = observedPromptCacheTier(reply.usage) ?? resolvePromptCacheTier(model, undefined, isOAuth);
	const seconds = tier && model.promptCache?.[tier];
	return seconds ? { expiresAt: touchedAt + seconds * 1000, ttlSeconds: seconds, stale } : undefined;
}
