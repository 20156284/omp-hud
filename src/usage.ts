import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { limitMatchesActiveAccount } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account";

export type AccountIdentity = Parameters<typeof limitMatchesActiveAccount>[2];

export type WindowKind = "fiveHour" | "daily" | "weekly" | "monthly";

export const WINDOW_ORDER: readonly WindowKind[] = ["fiveHour", "daily", "weekly", "monthly"];

export interface Meter {
	/** 分模型限额（如 Claude Fable）；总额度为空。 */
	tier?: string;
	percent: number;
	resetsAt?: number;
	/** 视窗总长，用于推算用量配速。 */
	windowMs: number;
}

export interface QuotaGroup {
	provider: string;
	/** 每个窗口的计量，总额度排第一。 */
	windows: Partial<Record<WindowKind, Meter[]>>;
}

const HOUR_MS = 3_600_000;
const DURATION_TOLERANCE_MS = 60_000;
const WINDOW_MS: Record<WindowKind, number> = {
	fiveHour: 5 * HOUR_MS,
	daily: 24 * HOUR_MS,
	weekly: 7 * 24 * HOUR_MS,
	monthly: 30 * 24 * HOUR_MS,
};

function windowKind(limit: UsageLimit): WindowKind | undefined {
	const id = limit.scope.windowId;
	const durationMs = limit.window?.durationMs;
	const lasts = (hours: number) =>
		durationMs !== undefined && Math.abs(durationMs - hours * HOUR_MS) <= DURATION_TOLERANCE_MS;
	if (id === "5h" || lasts(5)) return "fiveHour";
	if (id === "daily" || id === "24h" || id === "1d" || lasts(24)) return "daily";
	if (id === "7d" || lasts(7 * 24)) return "weekly";
	if (id === "monthly" || id === "30d") return "monthly";
	return undefined;
}

/**
 * 每个已登录订阅各取一组额度，只认 `identityOf` 给出的帐号；认不出帐号的 provider 整组跳过。
 * 绑定具体模型的限额只在它就是当前模型时才算。
 */
export function selectQuotaGroups(
	reports: readonly UsageReport[] | undefined,
	current: { provider: string; id: string } | undefined,
	identityOf: (provider: string) => AccountIdentity,
): QuotaGroup[] {
	if (!reports) return [];
	const identities = new Map<string, AccountIdentity>();
	const picked = new Map<string, Map<WindowKind, Map<string, Meter & { modelScoped: boolean }>>>();
	for (const report of reports) {
		const { provider } = report;
		if (!identities.has(provider)) identities.set(provider, identityOf(provider));
		const identity = identities.get(provider);
		if (!identity) continue;
		for (const limit of report.limits) {
			const fraction = resolveUsedFraction(limit);
			const kind = windowKind(limit);
			if (!kind || typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
			const modelId = limit.scope.modelId?.toLowerCase();
			if (modelId && (provider !== current?.provider || modelId !== current.id.toLowerCase())) continue;
			if (!limitMatchesActiveAccount(report, limit, identity)) continue;
			const tier = limit.scope.tier?.trim() || undefined;
			const windows = picked.get(provider) ?? new Map();
			picked.set(provider, windows);
			const meters = windows.get(kind) ?? new Map();
			windows.set(kind, meters);
			const key = tier?.toLowerCase() ?? "";
			// 同一档同时有模型专属与通用两条时，模型专属更贴近当前用量
			if (meters.get(key)?.modelScoped && !modelId) continue;
			meters.set(key, {
				tier,
				percent: fraction * 100,
				resetsAt: limit.window?.resetsAt,
				windowMs: limit.window?.durationMs ?? WINDOW_MS[kind],
				modelScoped: !!modelId,
			});
		}
	}
	return [...picked]
		.map(([provider, windows]) => ({
			provider,
			windows: Object.fromEntries(
				[...windows].map(([kind, meters]) => [
					kind,
					[...meters.values()]
						.sort((a, b) => (a.tier ?? "").localeCompare(b.tier ?? ""))
						.map(({ tier, percent, resetsAt, windowMs }) => ({ tier, percent, resetsAt, windowMs })),
				]),
			),
		}))
		.sort((a, b) =>
			a.provider === current?.provider ? -1 : b.provider === current?.provider ? 1 : a.provider.localeCompare(b.provider),
		);
}
