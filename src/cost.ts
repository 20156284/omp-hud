import * as fs from "node:fs";
import * as path from "node:path";

/** 一个会话文件里的计费记录：`[时间戳, 费用]`，按条目去重键存放。 */
export interface FileCharges {
	mtimeMs: number;
	size: number;
	charges: Map<string, readonly [number, number]>;
}

export interface CostTotals {
	today: number;
	week: number;
}

interface ChargedEntry {
	type?: string;
	id?: string;
	timestamp?: string;
	usage?: { cost?: { total?: number } };
	message?: { role?: string; timestamp?: number; usage?: { cost?: { total?: number } } };
}

function chargeOf(entry: ChargedEntry): readonly [number, number] | undefined {
	if (entry.type === "message" && entry.message?.role === "assistant") {
		const cost = entry.message.usage?.cost?.total;
		return cost && entry.message.timestamp ? [entry.message.timestamp, cost] : undefined;
	}
	// 标题、暖机等旁路调用也计费
	if (entry.type === "model_usage") {
		const cost = entry.usage?.cost?.total;
		const at = Date.parse(entry.timestamp ?? "");
		return cost && !Number.isNaN(at) ? [at, cost] : undefined;
	}
	return undefined;
}

async function readCharges(file: string): Promise<FileCharges["charges"]> {
	const charges: FileCharges["charges"] = new Map();
	for (const line of (await Bun.file(file).text()).split("\n")) {
		if (!line.includes('"cost"')) continue;
		try {
			const entry = JSON.parse(line) as ChargedEntry;
			const charge = chargeOf(entry);
			if (charge && entry.id) charges.set(`${entry.id}@${charge[0]}`, charge);
		} catch {
			// 写到一半的末行，下次再读
		}
	}
	return charges;
}

/**
 * 汇总 `root` 下所有会话文件自 `todayStart`、`weekStart` 起的费用。
 * 只重读改动过的文件；分叉复制的条目按条目 ID 去重。
 */
export async function costTotals(
	root: string,
	todayStart: number,
	weekStart: number,
	cache: Map<string, FileCharges>,
): Promise<CostTotals> {
	const earliest = Math.min(todayStart, weekStart);
	const files = (await fs.promises.readdir(root, { recursive: true })).filter(name => name.endsWith(".jsonl"));
	const seen = new Set<string>();
	for (const name of files) {
		const file = path.join(root, name);
		const stat = await fs.promises.stat(file).catch(() => undefined);
		if (!stat || stat.mtimeMs < earliest) continue;
		seen.add(file);
		const cached = cache.get(file);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
		cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, charges: await readCharges(file) });
	}
	for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
	const charges = new Map<string, readonly [number, number]>();
	for (const entry of cache.values()) for (const [id, charge] of entry.charges) charges.set(id, charge);
	const totals: CostTotals = { today: 0, week: 0 };
	for (const [at, cost] of charges.values()) {
		if (at >= todayStart) totals.today += cost;
		if (at >= weekStart) totals.week += cost;
	}
	return totals;
}
