import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoItem as OmpTodo } from "@oh-my-pi/pi-tui/tools/todo";
import type { Answers, Ask, Probe } from "../vendor/claude-hud/src/channel.ts";
import type { AgentEntry, TodoItem, ToolEntry, TranscriptData, UsageData } from "../vendor/claude-hud/src/types.ts";
import type { Meter, QuotaGroup } from "./usage";

/** Claude HUD 的配置文件；OMP 专属的覆盖写在 `~/.omp/agent/omp-hud.json`，键逐个盖过它。 */
export function claudeHudConfigPath(): string {
	const custom = process.env.CLAUDE_CONFIG_DIR?.trim();
	const configDir = custom ? path.resolve(custom.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), ".claude");
	return path.join(configDir, "plugins", "claude-hud", "config.json");
}

const TOOLS_KEPT = 20;
const BASH_TARGET_MAX = 30;
const SKILL_PREFIX = "skill://";
const DEVICE_PREFIX = "xd://";
// 子代理和待办在 Claude HUD 里各有一行，不算进工具行
const NON_TOOL_CALLS: Record<string, true> = { task: true, todo: true };
// 与 Claude HUD collector 相同：不抢 index 锁、不跑仓库自带的 fsmonitor
const SAFE_GIT_ARGS = ["-c", "core.quotePath=false", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never"];
const GIT_PROBES: Partial<Record<Probe, { args: string[]; timeout: number; safe: boolean }>> = {
	"git.status": { args: ["status", "--porcelain=v2", "--branch", "-z", "--ignore-submodules=dirty"], timeout: 1000, safe: true },
	"git.numstat": { args: ["diff-index", "-M", "--numstat", "-z", "--ignore-submodules=dirty", "HEAD"], timeout: 2000, safe: true },
	"git.branch": { args: ["rev-parse", "--abbrev-ref", "HEAD"], timeout: 1000, safe: false },
	"git.describe": { args: ["describe", "--tags", "--exact-match", "HEAD"], timeout: 1000, safe: false },
};

/** Claude HUD 的探针接口：git 与内存照 collector.mjs 的命令跑，其余探针 OMP 不提供。 */
export function probeAsk(pi: ExtensionAPI, cwd: string): Ask {
	return async probes => {
		const answers: Answers = {};
		await Promise.all(
			probes.map(async probe => {
				const git = GIT_PROBES[probe];
				if (git) {
					const result = await pi.exec("git", git.safe ? [...SAFE_GIT_ARGS, ...git.args] : git.args, { cwd, timeout: git.timeout });
					answers[probe] = result.killed ? { error: "timeout" } : result.code === 0 ? { stdout: result.stdout } : { error: "failed" };
				} else if (probe === "memory") {
					answers.memory =
						process.platform === "darwin"
							? { vmStat: (await pi.exec("/usr/bin/vm_stat", [], { timeout: 1000 })).stdout }
							: process.platform === "linux"
								? { meminfo: await fs.promises.readFile("/proc/meminfo", "utf8").catch(() => null) }
								: {};
				}
			}),
		);
		return answers;
	};
}

function toolTarget(name: string, args: Record<string, unknown>): string | undefined {
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	switch (name) {
		case "read":
		case "write":
		case "edit":
			return text(args.path);
		case "grep":
		case "glob":
		case "find":
			return text(args.pattern);
		case "bash": {
			const command = text(args.command)?.replace(/\s+/g, " ");
			return command && command.length > BASH_TARGET_MAX ? `${command.slice(0, BASH_TARGET_MAX).trimEnd()}...` : command;
		}
	}
	return undefined;
}

export interface TranscriptInputs {
	branch: readonly SessionEntry[];
	running: ReadonlySet<string>;
	mcpServerOf: ReadonlyMap<string, string>;
	sessionStart?: number;
	sessionTokens: TranscriptData["sessionTokens"];
	contextTokens?: number;
}

/** 把 OMP 的会话分支折成 Claude HUD 从 transcript 解析出的结构。 */
export function transcriptOf(inputs: TranscriptInputs): Omit<TranscriptData, "agents" | "todos"> {
	const tools = new Map<string, ToolEntry>();
	const toolServers = new Map<string, string>();
	const skills = new Set<string>();
	const mcpServers = new Set<string>();
	const mcpErrors = new Set<string>();
	let lastReply: SessionEntry | undefined;
	let lastAssistantModel: string | undefined;
	let compactionCount = 0;
	for (const entry of inputs.branch) {
		if (entry.type === "compaction") compactionCount++;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			const tool = tools.get(message.toolCallId);
			if (tool) Object.assign(tool, { status: message.isError ? "error" : "completed", endTime: new Date(message.timestamp) });
			const server = toolServers.get(message.toolCallId);
			if (server) message.isError ? mcpErrors.add(server) : mcpErrors.delete(server);
			continue;
		}
		if (message.role !== "assistant") continue;
		lastReply = entry;
		lastAssistantModel = message.model;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const target = typeof block.arguments.path === "string" ? block.arguments.path : undefined;
			if (block.name === "read" && target?.startsWith(SKILL_PREFIX)) {
				// 去掉子路径和 `:1-5` 这类行号选择器
				const skill = target.slice(SKILL_PREFIX.length).split(/[/:]/)[0];
				if (skill) skills.add(skill);
			}
			const server = inputs.mcpServerOf.get(target?.startsWith(DEVICE_PREFIX) ? target.slice(DEVICE_PREFIX.length) : block.name);
			if (server) {
				mcpServers.add(server);
				toolServers.set(block.id, server);
			}
			if (NON_TOOL_CALLS[block.name]) continue;
			tools.set(block.id, {
				id: block.id,
				name: block.name,
				target: toolTarget(block.name, block.arguments),
				// 没等到结果又不在执行中的（中断、重放）按已完成算
				status: inputs.running.has(block.id) ? "running" : "completed",
				startTime: new Date(message.timestamp),
			});
		}
	}
	return {
		tools: [...tools.values()].slice(-TOOLS_KEPT),
		skills: [...skills],
		mcpServers: [...mcpServers],
		mcpErrors: [...mcpErrors],
		sessionStart: inputs.sessionStart === undefined ? undefined : new Date(inputs.sessionStart),
		lastAssistantResponseAt: lastReply?.type === "message" ? new Date(lastReply.message.timestamp) : undefined,
		sessionTokens: inputs.sessionTokens,
		compactionCount,
		contextTokens: inputs.contextTokens,
		lastAssistantModel,
	};
}

export interface TaskSpawn {
	type: string;
	model?: string;
}

/** 后台子代理：`task` 的异步作业，类型与模型取自派发时的参数。 */
export function agentsOf(
	jobs: AsyncJobSnapshot | null,
	spawns: ReadonlyMap<string, TaskSpawn>,
): AgentEntry[] {
	if (!jobs) return [];
	return [...jobs.recent, ...jobs.running]
		.filter(job => job.type === "task")
		.map(job => ({
			id: job.id,
			type: spawns.get(job.label)?.type ?? "task",
			model: spawns.get(job.label)?.model,
			description: job.intent ?? job.label,
			status: job.status === "running" ? "running" : "completed",
			startTime: new Date(job.startTime),
			endTime: job.endTime === undefined ? undefined : new Date(job.endTime),
			background: true,
		}));
}

export function todosOf(todos: readonly OmpTodo[]): TodoItem[] {
	return todos.map(todo => ({ content: todo.content, status: todo.status === "abandoned" ? "completed" : todo.status }));
}

/**
 * Claude HUD 只认一家订阅：取当前模型那家的 5 小时与每周，分模型的每周限额作为 scoped 视窗。
 * Claude Code 给的已用百分比是整数，这里同样取整。
 */
export function usageDataOf(group: QuotaGroup | undefined): UsageData | null {
	const fiveHour = group?.windows.fiveHour?.[0];
	const [weekly, ...scoped] = group?.windows.weekly ?? [];
	if (!fiveHour && !weekly) return null;
	const resetAt = (at: number | undefined) => (at === undefined ? null : new Date(at));
	const percent = (meter: Meter | undefined) => (meter ? Math.round(meter.percent) : null);
	return {
		fiveHour: percent(fiveHour),
		sevenDay: percent(weekly),
		fiveHourResetAt: resetAt(fiveHour?.resetsAt),
		sevenDayResetAt: resetAt(weekly?.resetsAt),
		scopedWindows: scoped.map(meter => ({
			label: meter.tier ? meter.tier[0].toUpperCase() + meter.tier.slice(1) : "",
			percent: percent(meter),
			resetAt: resetAt(meter.resetsAt),
		})),
	};
}
