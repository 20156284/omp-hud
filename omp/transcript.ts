import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoItem as OmpTodo } from "@oh-my-pi/pi-tui/tools/todo";
import type { AgentEntry, TodoItem, ToolEntry, TranscriptData } from "../src/types.ts";

const TOOLS_KEPT = 20;
const BASH_TARGET_MAX = 30;
const SKILL_PREFIX = "skill://";
const DEVICE_PREFIX = "xd://";
// 子代理和待办在 Claude HUD 里各有一行，不算进工具行
const NON_TOOL_CALLS: Record<string, true> = { task: true, todo: true };

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

/** 把 omp 的会话分支折成 Claude HUD 从 transcript 解析出的结构。 */
export function transcriptOf(inputs: TranscriptInputs): Omit<TranscriptData, "agents" | "todos"> {
	const tools = new Map<string, ToolEntry>();
	const toolServers = new Map<string, string>();
	const skills = new Set<string>();
	const mcpServers = new Set<string>();
	const mcpErrors = new Set<string>();
	let lastReplyAt: number | undefined;
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
		lastReplyAt = message.timestamp;
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
		lastAssistantResponseAt: lastReplyAt === undefined ? undefined : new Date(lastReplyAt),
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
export function agentsOf(jobs: AsyncJobSnapshot | null, spawns: ReadonlyMap<string, TaskSpawn>): AgentEntry[] {
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
