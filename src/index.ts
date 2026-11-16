import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { type ContextUsage, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { TodoItem as OmpTodo } from "@oh-my-pi/pi-tui/tools/todo";
import { type HudConfig, loadConfigFiles } from "../vendor/claude-hud/src/config.ts";
import { getGitStatus, type GitStatus } from "../vendor/claude-hud/src/git.ts";
import { setLanguage } from "../vendor/claude-hud/src/i18n/index.ts";
import { getJjStatus } from "../vendor/claude-hud/src/jj.ts";
import { getMemoryUsage, type MemoryFacts, readMemory } from "../vendor/claude-hud/src/memory.ts";
import { label, RESET } from "../vendor/claude-hud/src/render/colors.ts";
import { renderLines } from "../vendor/claude-hud/src/render/index.ts";
import type { MemoryInfo, StdinData, TranscriptData } from "../vendor/claude-hud/src/types.ts";
import { type PromptCacheInfo, promptCacheInfo } from "./cache";
import {
	agentsOf,
	claudeHudConfigPath,
	probeAsk,
	type TaskSpawn,
	todosOf,
	transcriptOf,
	usageDataOf,
} from "./claude-hud";
import { type CostTotals, costTotals, type FileCharges } from "./cost";
import { selectQuotaGroups } from "./usage";

const WIDGET_KEY = "omp-hud";
const TICK_MS = 30_000;
// 每次回复的限额响应头会被 OMP 并入用量缓存（最多每分钟一次），常问只读缓存；缓存过期才打上游，频率由 OMP 控制
const USAGE_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 3_000;
const DAY_MS = 24 * 60 * 60_000;
// 太短的回复算出的速度跳动大，不采用
const MIN_RATE_WINDOW_MS = 500;
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"];

export default function ompHud(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let config: HudConfig | undefined;
	let gitStatus: GitStatus | null = null;
	let worktree: string | undefined;
	let gitInFlight = false;
	let tickets: string[] = [];
	let context: ContextUsage | undefined;
	let promptCache: PromptCacheInfo | undefined;
	let cacheHitRatio: number | undefined;
	let outputRate: number | undefined;
	let streamStartedAt: number | undefined;
	let transcript: Omit<TranscriptData, "agents" | "todos"> = { tools: [], skills: [], mcpServers: [], mcpErrors: [] };
	let todos: OmpTodo[] = [];
	let counts = { claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0 };
	let sessionCost = 0;
	let costs: CostTotals | undefined;
	let costsInFlight = false;
	const costCache = new Map<string, FileCharges>();
	let memory: MemoryInfo | null = null;
	let reports: UsageReport[] | undefined;
	let usageInFlight = false;
	const running = new Set<string>();
	// 子代理作业以派发时的名字为标签，记下它的代理类型和模型
	const spawns = new Map<string, TaskSpawn>();

	const requestRender = () => tui?.requestRender();

	function reloadConfig(): void {
		const loaded = loadConfigFiles({ config: claudeHudConfigPath(), override: path.join(getAgentDir(), "omp-hud.json") });
		if (loaded.problems.length) pi.logger.debug("omp-hud: config problems", { problems: loaded.problems });
		config = loaded.config;
		setLanguage(config.language);
	}

	async function refreshUsage(current: ExtensionContext): Promise<void> {
		if (usageInFlight) return;
		usageInFlight = true;
		try {
			// 与 `/usage` 传同样的 baseUrl，命中同一条缓存，两边数字才一致
			reports =
				(await current.modelRegistry.authStorage.usage.reports({
					baseUrlResolver: provider => current.modelRegistry.getProviderBaseUrl(provider),
					signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
				})) ?? undefined;
		} catch (error) {
			pi.logger.debug("omp-hud: usage fetch failed", { error: String(error) });
		} finally {
			usageInFlight = false;
			requestRender();
		}
	}

	/** git 状态交给 Claude HUD 自己的解析；链接工作树名由 Claude Code 经 stdin 给出，这里自己查。 */
	async function refreshGit(current: ExtensionContext): Promise<void> {
		if (gitInFlight || !config) return;
		gitInFlight = true;
		try {
			const ask = probeAsk(pi, current.cwd);
			const [status, dirs] = await Promise.all([
				(config.jjStatus.enabled ? await getJjStatus(ask) : null) ??
					(config.gitStatus.enabled ? getGitStatus(ask, { lineDiffs: config.gitStatus.showFileStats }) : null),
				pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], {
					cwd: current.cwd,
					timeout: GIT_TIMEOUT_MS,
				}),
			]);
			gitStatus = status;
			// 链接工作树的 git-dir 与共享的 common-dir 不同
			const [gitDir, commonDir, topLevel] = dirs.stdout.trim().split("\n");
			worktree = dirs.code === 0 && gitDir !== commonDir && topLevel ? path.basename(topLevel) : undefined;
		} finally {
			gitInFlight = false;
			requestRender();
		}
	}

	async function refreshMemory(current: ExtensionContext): Promise<void> {
		if (!config?.display.showMemoryUsage) return;
		const { memory: facts } = await probeAsk(pi, current.cwd)(["memory"]);
		memory = getMemoryUsage(readMemory(facts as MemoryFacts));
		requestRender();
	}

	// 工单工人进度：从 cwd 往上找 _tickets/doing，按回执目录的 .status 判断成败
	async function refreshTickets(current: ExtensionContext): Promise<void> {
		let root = current.cwd;
		while (!fs.existsSync(path.join(root, "_tickets/doing")) && path.dirname(root) !== root) root = path.dirname(root);
		const doing = path.join(root, "_tickets/doing");
		const names = fs.existsSync(doing) ? (await fs.promises.readdir(doing)).filter(name => name.endsWith(".md")) : [];
		tickets = await Promise.all(
			names.map(async name => {
				const base = path.join(root, "_receipts", name.slice(0, -3));
				const id = name.split("-")[0];
				const status = await Bun.file(`${base}.status`).text().catch(() => undefined);
				if (status !== undefined) return /^exit=0$/m.test(status) ? `${id}✓` : `${id}✗`;
				const started = await fs.promises.stat(`${base}.run.log`).then(stat => stat.birthtimeMs, () => Date.now());
				return `${id}▶${Math.floor((Date.now() - started) / 60_000)}m`;
			}),
		);
		requestRender();
	}

	/** 对应 Claude HUD 的环境计数：上下文文件、扩展（OMP 的 hook 即扩展）；MCP 数随会话刷新。 */
	async function refreshCounts(current: ExtensionContext): Promise<void> {
		const dirs: string[] = [];
		for (let dir = current.cwd; ; dir = path.dirname(dir)) {
			dirs.push(dir);
			if (dir === path.dirname(dir) || dir === os.homedir()) break;
		}
		const contextFiles = [...dirs, getAgentDir()].flatMap(dir => CONTEXT_FILES.map(name => path.join(dir, name)));
		const extensions = await fs.promises.readdir(path.join(getAgentDir(), "extensions")).catch(() => []);
		counts = {
			...counts,
			claudeMdCount: contextFiles.filter(file => fs.existsSync(file)).length,
			hooksCount: extensions.filter(name => !name.startsWith(".")).length,
		};
		requestRender();
	}

	function refreshSession(current: ExtensionContext): void {
		context = current.getContextUsage();
		const branch = current.sessionManager.getBranch();
		promptCache = promptCacheInfo(branch, current.modelRegistry, current.model);
		todos = getLatestTodoPhasesFromEntries(branch).flatMap(phase => phase.tasks);
		const mcpServerOf = new Map(
			pi.getAllTools().flatMap(tool => (tool.mcpServerName ? [[tool.name, tool.mcpServerName] as const] : [])),
		);
		const { cacheRead, cacheWrite, input, output, cost } = current.sessionManager.getUsageStatistics();
		sessionCost = cost;
		cacheHitRatio = cacheRead > 0 ? cacheRead / (cacheRead + cacheWrite + input) : undefined;
		transcript = transcriptOf({
			branch,
			running,
			mcpServerOf,
			sessionStart: sessionStartOf(current),
			sessionTokens: { inputTokens: input, outputTokens: output, cacheCreationTokens: cacheWrite, cacheReadTokens: cacheRead },
			contextTokens: context?.tokens,
		});
		counts = { ...counts, mcpCount: new Set(mcpServerOf.values()).size };
		requestRender();
	}

	/** 今日从本地零点算；本周跟当前订阅的每周额度视窗走，没有就取最近 7 天。 */
	async function refreshCosts(current: ExtensionContext): Promise<void> {
		if (costsInFlight) return;
		costsInFlight = true;
		try {
			const now = Date.now();
			const weekly = currentQuota(current)?.windows.weekly?.[0];
			costs = await costTotals(
				path.dirname(current.sessionManager.getSessionDir()),
				new Date(now).setHours(0, 0, 0, 0),
				weekly?.resetsAt === undefined ? now - 7 * DAY_MS : weekly.resetsAt - weekly.windowMs,
				costCache,
			);
		} catch (error) {
			pi.logger.debug("omp-hud: cost scan failed", { error: String(error) });
		} finally {
			costsInFlight = false;
			requestRender();
		}
	}

	function sessionStartOf(current: ExtensionContext): number | undefined {
		const startedAt = Date.parse(current.sessionManager.getHeader()?.timestamp ?? "");
		return Number.isNaN(startedAt) ? undefined : startedAt;
	}

	function currentQuota(current: ExtensionContext) {
		const sessionId = current.sessionManager.getSessionId();
		const [group] = selectQuotaGroups(reports, current.model, provider =>
			current.modelRegistry.authStorage.oauth.identity(provider, sessionId),
		);
		return group?.provider === current.model?.provider ? group : undefined;
	}

	/** 照 Claude Code 交给 statusline 的 stdin 结构组装当前会话。 */
	function stdinOf(current: ExtensionContext, now: number): StdinData {
		const sessionStart = sessionStartOf(current);
		const cacheLive = promptCache?.expiresAt !== undefined && !promptCache.stale;
		return {
			session_id: current.sessionManager.getSessionId(),
			session_name: pi.getSessionName(),
			cwd: current.cwd,
			workspace: { current_dir: current.cwd, project_dir: current.cwd, git_worktree: worktree },
			model: { id: current.model?.id, display_name: current.model?.name },
			context_window: context && {
				context_window_size: context.contextWindow,
				used_percentage: context.percent,
				current_usage: { input_tokens: context.tokens },
			},
			cost: { total_cost_usd: sessionCost, total_duration_ms: sessionStart === undefined ? null : now - sessionStart },
			prompt_cache: {
				caching_observed: promptCache?.expiresAt !== undefined,
				warm: cacheLive,
				ttl: promptCache?.ttlSeconds === 3600 ? "1h" : "5m",
				expires_at: promptCache?.expiresAt === undefined ? null : promptCache.expiresAt / 1000,
				hit_ratio: cacheHitRatio ?? null,
			},
			effort: { level: pi.getThinkingLevel() },
		};
	}

	function render(current: ExtensionContext, hudConfig: HudConfig, width: number): string[] {
		const now = Date.now();
		const quota = currentQuota(current);
		const email = current.model && current.modelRegistry.authStorage.oauth.identity(current.model.provider, current.sessionManager.getSessionId())?.email;
		const lines = renderLines(
			{
				stdin: stdinOf(current, now),
				transcript: { ...transcript, agents: agentsOf(current.getAsyncJobSnapshot(), spawns), todos: todosOf(todos) },
				...counts,
				costTotals: costs ? { todayUsd: costs.today, weekUsd: costs.week } : null,
				outputSpeed: outputRate ?? null,
				gitStatus,
				usageData: hudConfig.display.showUsage ? usageDataOf(quota) : null,
				memoryUsage: memory,
				config: hudConfig,
				extraLabel: null,
				authInfo: email ? { method: null, user: email.split("@")[0], email } : null,
			},
			width,
			now,
		);
		if (tickets.length) lines.push(`${RESET}${label("工人 ", hudConfig.colors)}${tickets.join(" ")}`);
		return lines;
	}

	function mount(current: ExtensionContext): void {
		ctx = current;
		if (!current.hasUI || current.mode !== "tui" || current.agent.kind !== "main") return;
		reloadConfig();
		current.ui.setWidget(
			WIDGET_KEY,
			host => {
				tui = host;
				return {
					render: width => (ctx && config ? render(ctx, config, Math.max(1, width)) : []),
					invalidate: () => {},
					dispose: () => {
						if (tui === host) tui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
		current.setInterval(() => {
			if (!ctx) return;
			// 配置文件随时可能被 /hud 改掉，与 Claude HUD 一样每次刷新都重读
			reloadConfig();
			void refreshUsage(ctx);
			void refreshGit(ctx);
			void refreshTickets(ctx);
			void refreshCosts(ctx);
			void refreshMemory(ctx);
			void refreshCounts(ctx);
			// 闲置时缓存暖机会追加刷新记录，换模型也没有事件，靠这里重算
			refreshSession(ctx);
		}, TICK_MS);
		refreshSession(current);
		void refreshGit(current);
		void refreshTickets(current);
		void refreshMemory(current);
		void refreshCounts(current);
		void refreshUsage(current).then(() => refreshCosts(current));
	}

	pi.on("session_start", (_event, current) => mount(current));
	pi.on("session_switch", (_event, current) => {
		running.clear();
		spawns.clear();
		outputRate = undefined;
		streamStartedAt = undefined;
		ctx = current;
		refreshSession(current);
		void refreshCounts(current);
		void refreshUsage(current);
	});
	pi.on("session_shutdown", (_event, current) => {
		current.ui.setWidget(WIDGET_KEY, undefined);
		ctx = undefined;
		tui = undefined;
	});

	pi.on("agent_start", (_event, current) => {
		ctx = current;
		running.clear();
		requestRender();
	});
	pi.on("agent_end", (_event, current) => {
		running.clear();
		refreshSession(current);
		void refreshGit(current);
		void refreshTickets(current);
		void refreshCosts(current);
	});
	pi.on("turn_end", (_event, current) => {
		refreshSession(current);
		void refreshUsage(current);
	});
	pi.on("session_compact", (_event, current) => refreshSession(current));
	pi.on("session_tree", (_event, current) => refreshSession(current));
	pi.on("session_branch", (_event, current) => refreshSession(current));
	pi.on("session_clear", (_event, current) => refreshSession(current));

	// 生成速度只计首个增量之后的时间，不含排队与首字延迟
	pi.on("message_update", event => {
		if (event.message.role === "assistant" && event.assistantMessageEvent.type !== "start") streamStartedAt ??= Date.now();
	});
	pi.on("message_end", (event, current) => {
		if (event.message.role !== "assistant") return;
		const elapsed = streamStartedAt === undefined ? 0 : Date.now() - streamStartedAt;
		streamStartedAt = undefined;
		if (elapsed >= MIN_RATE_WINDOW_MS && event.message.usage.output > 0) {
			outputRate = event.message.usage.output / (elapsed / 1000);
		}
		// 工具调用要等这则回复落盘后才查得到
		refreshSession(current);
	});

	pi.on("tool_execution_start", (event, current) => {
		running.add(event.toolCallId);
		const tasks = (event.args as { tasks?: { name?: string; agent?: string; model?: string }[] } | undefined)?.tasks;
		for (const task of event.toolName === "task" && Array.isArray(tasks) ? tasks : []) {
			if (task.name) spawns.set(task.name, { type: task.agent ?? "task", model: task.model });
		}
		refreshSession(current);
	});
	pi.on("tool_execution_end", (event, current) => {
		running.delete(event.toolCallId);
		refreshSession(current);
	});
}
