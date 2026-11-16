import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, UsageReport } from "@oh-my-pi/pi-ai";
import { type ContextUsage, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TUI } from "@oh-my-pi/pi-tui";
import { detectTerminalBackground, theme } from "@oh-my-pi/pi-tui/theme";
import type { TodoItem as OmpTodo } from "@oh-my-pi/pi-tui/tools/todo";
import { claudePaths, createProbes, logicPaths } from "../collector.mjs";
import { terminalFilter } from "../hud.mjs";
import type { Ask, Paths } from "../src/channel.ts";
import type { ConfigCounts } from "../src/config-reader.ts";
import { type HudConfig, loadConfigFiles } from "../src/config.ts";
import type { CostTotals } from "../src/daily-cost.ts";
import type { GitRepoIdentity } from "../src/git.ts";
import { problemLine, renderStdin } from "../src/main.ts";
import { truncateToWidth } from "../src/render/ansi.ts";
import { label, RESET } from "../src/render/colors.ts";
import type { StdinData, TranscriptData } from "../src/types.ts";
import { type PromptCacheInfo, promptCacheInfo } from "./cache";
import { costTotals, type FileCharges, weekStartOf } from "./cost";
import { agentsOf, type TaskSpawn, todosOf, transcriptOf } from "./transcript";
import { rateLimitsOf, scopedSnapshotOf, selectQuotaGroups } from "./usage";

const WIDGET_KEY = "omp-hud";
const TICK_MS = 30_000;
// 有工具或子代理在跑时逐秒重画，让耗时与状态跟着走
const LIVE_MS = 1_000;
// 每次回复的限额响应头会被 omp 并入用量缓存（最多每分钟一次），常问只读缓存；缓存过期才打上游，频率由 omp 控制
const USAGE_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 3_000;
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"];
// Claude Code 给 statusline 左右各留 2 列
const PAD = "  ";
// 额度由 omp 经 usage.read 探针提供；Claude HUD 只在配了外部额度路径时才问这个探针
const OMP_USAGE_SOURCE = "omp://usage";
const OVERRIDE_PATH = path.join(getAgentDir(), "omp-hud.json");
const DATA_DIR = path.join(getAgentDir(), "omp-hud");
const NO_COUNTS: ConfigCounts = { claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0 };

/** Claude Code 把 statusline 无色文字染成主题 inactive 色（深色 #999999、浅色 #666666），每次 RESET 后都回到它。 */
function baseGray(): string {
	const hex = detectTerminalBackground() === "light" ? "#666666" : "#999999";
	return Bun.color(hex, theme.getColorMode() === "truecolor" ? "ansi-16m" : "ansi-256") ?? "";
}

export default function ompHud(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let config: HudConfig | undefined;
	let problems: string[] = [];
	let probes: Ask | undefined;
	let worktree: string | undefined;
	let repo: GitRepoIdentity | undefined;
	let tickets: string[] = [];
	let context: ContextUsage | undefined;
	let promptCache: PromptCacheInfo | undefined;
	let cacheHitRatio: number | undefined;
	let lastUsage: AssistantMessage["usage"] | undefined;
	let sessionTotals = { input: 0, output: 0, cost: 0 };
	let apiDurationMs = 0;
	let transcript: Omit<TranscriptData, "agents" | "todos"> = { tools: [], skills: [], mcpServers: [], mcpErrors: [] };
	let todos: OmpTodo[] = [];
	let counts = NO_COUNTS;
	let costs: CostTotals | null = null;
	let costsInFlight = false;
	const costCache = new Map<string, FileCharges>();
	let reports: UsageReport[] | undefined;
	let usageInFlight = false;
	const running = new Set<string>();
	// 子代理作业以派发时的名字为标签，记下它的代理类型和模型
	const spawns = new Map<string, TaskSpawn>();
	let output: { width: number; lines: string[] } | undefined;
	let width = 0;
	let rendering = false;
	let stale = false;
	let wasBusy = false;

	/** 数据变了就重算：Claude HUD 的渲染是异步的，结果缓存起来供界面同步取用。 */
	function refresh(): void {
		stale = true;
		void rerender();
	}

	async function rerender(): Promise<void> {
		if (rendering || !width) return;
		rendering = true;
		try {
			while (stale && ctx && config && probes) {
				stale = false;
				output = { width, lines: await compose(ctx, config, probes, width) };
				tui?.requestRender();
			}
		} catch (error) {
			pi.logger.debug("omp-hud: render failed", { error: String(error) });
		} finally {
			rendering = false;
		}
	}

	function reloadConfig(): void {
		const loaded = loadConfigFiles({ config: claudePaths().configPath, override: OVERRIDE_PATH });
		problems = loaded.problems;
		config = { ...loaded.config, display: { ...loaded.config.display, externalUsagePath: OMP_USAGE_SOURCE } };
	}

	/** 照 Claude HUD collector 的探针跑 git 与内存；每个探针在一次刷新周期内只跑一次。 */
	function renewProbes(current: ExtensionContext): void {
		probes = createProbes({ cwd: current.cwd, argv: [] });
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
			refresh();
		}
	}

	/** Claude Code 经 stdin 给出的链接工作树名与 origin 仓库，这里自己查：链接工作树的 git-dir 与共享的 common-dir 不同。 */
	async function refreshWorkspace(current: ExtensionContext): Promise<void> {
		const git = (args: string[]) => pi.exec("git", args, { cwd: current.cwd, timeout: GIT_TIMEOUT_MS });
		const [dirs, origin] = await Promise.all([
			git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]),
			git(["remote", "get-url", "origin"]),
		]);
		const [gitDir, commonDir, topLevel] = dirs.stdout.trim().split("\n");
		worktree = dirs.code === 0 && gitDir !== commonDir && topLevel ? path.basename(topLevel) : undefined;
		// git@host:owner/name.git、https://host/owner/name、ssh://git@host:22/owner/name
		const [, host, owner, name] = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin.code === 0 ? origin.stdout.trim() : "") ?? [];
		repo = host ? { host, owner, name } : undefined;
		refresh();
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
		refresh();
	}

	/** 对应 Claude HUD 的环境计数：上下文文件、扩展（omp 的 hook 即扩展）；MCP 数随会话刷新。 */
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
		refresh();
	}

	function refreshSession(current: ExtensionContext): void {
		context = current.getContextUsage();
		const branch = current.sessionManager.getBranch();
		promptCache = promptCacheInfo(branch, current.modelRegistry, current.model);
		todos = getLatestTodoPhasesFromEntries(branch).flatMap(phase => phase.tasks);
		// Claude Code 的 current_usage 是最近一次调用的用量，/compact 后清空；total_api_duration_ms 是各次请求时长之和
		lastUsage = undefined;
		apiDurationMs = 0;
		for (const entry of branch) {
			if (entry.type === "compaction") lastUsage = undefined;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			apiDurationMs += entry.message.duration ?? 0;
			if (entry.message.stopReason !== "error") lastUsage = entry.message.usage;
		}
		const mcpServerOf = new Map(
			pi.getAllTools().flatMap(tool => (tool.mcpServerName ? [[tool.name, tool.mcpServerName] as const] : [])),
		);
		const { cacheRead, cacheWrite, input, output: outputTokens, cost } = current.sessionManager.getUsageStatistics();
		sessionTotals = { input, output: outputTokens, cost };
		cacheHitRatio = cacheRead > 0 ? cacheRead / (cacheRead + cacheWrite + input) : undefined;
		transcript = transcriptOf({
			branch,
			running,
			mcpServerOf,
			sessionStart: sessionStartOf(current),
			sessionTokens: { inputTokens: input, outputTokens, cacheCreationTokens: cacheWrite, cacheReadTokens: cacheRead },
			contextTokens: context?.tokens,
		});
		counts = { ...counts, mcpCount: new Set(mcpServerOf.values()).size };
		refresh();
	}

	/** 今日从本地零点算；本周照 Claude HUD 的 weeklyCostPeriod，额度视窗起点取当前订阅的每周重置时刻。 */
	async function refreshCosts(current: ExtensionContext): Promise<void> {
		if (costsInFlight || !config) return;
		costsInFlight = true;
		try {
			const now = Date.now();
			costs = await costTotals(
				path.dirname(current.sessionManager.getSessionDir()),
				new Date(now).setHours(0, 0, 0, 0),
				weekStartOf(config.display.weeklyCostPeriod, currentQuota(current)?.windows.weekly?.[0]?.resetsAt, now),
				costCache,
			);
		} catch (error) {
			pi.logger.debug("omp-hud: cost scan failed", { error: String(error) });
		} finally {
			costsInFlight = false;
			refresh();
		}
	}

	function sessionStartOf(current: ExtensionContext): number | undefined {
		const startedAt = Date.parse(current.sessionManager.getHeader()?.timestamp ?? "");
		return Number.isNaN(startedAt) ? undefined : startedAt;
	}

	/** Claude HUD 只认一家订阅：取当前模型那家、这个会话所用帐号的额度。 */
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
		return {
			session_id: current.sessionManager.getSessionId(),
			session_name: pi.getSessionName(),
			transcript_path: current.sessionManager.getSessionFile(),
			cwd: current.cwd,
			workspace: { current_dir: current.cwd, project_dir: current.cwd, git_worktree: worktree, repo },
			model: { id: current.model?.id, display_name: current.model?.name },
			context_window: context && {
				context_window_size: context.contextWindow,
				used_percentage: context.percent,
				total_input_tokens: sessionTotals.input,
				total_output_tokens: sessionTotals.output,
				current_usage: lastUsage && {
					input_tokens: lastUsage.input,
					output_tokens: lastUsage.output,
					cache_creation_input_tokens: lastUsage.cacheWrite,
					cache_read_input_tokens: lastUsage.cacheRead,
				},
			},
			cost: {
				total_cost_usd: sessionTotals.cost,
				total_duration_ms: sessionStart === undefined ? null : now - sessionStart,
				total_api_duration_ms: apiDurationMs,
			},
			rate_limits: rateLimitsOf(currentQuota(current)),
			prompt_cache: {
				caching_observed: promptCache?.expiresAt !== undefined,
				warm: promptCache?.expiresAt !== undefined && !promptCache.stale,
				ttl: promptCache?.ttlSeconds === 3600 ? "1h" : "5m",
				expires_at: promptCache?.expiresAt === undefined ? null : promptCache.expiresAt / 1000,
				hit_ratio: cacheHitRatio ?? null,
			},
			effort: { level: pi.getThinkingLevel() },
		};
	}

	/** 一次完整的 Claude HUD 渲染，再照 Claude Code 显示 statusline 的方式加上过滤、底色与边距。 */
	async function compose(current: ExtensionContext, hudConfig: HudConfig, probe: Ask, terminalWidth: number): Promise<string[]> {
		const now = Date.now();
		const columns = Math.max(1, terminalWidth - 2 * PAD.length);
		const stdin = stdinOf(current, now);
		const usageSnapshot = scopedSnapshotOf(currentQuota(current), now);
		const ask: Ask = async names => ({
			...(await probe(names.filter(name => name !== "usage.read"))),
			...(names.includes("usage.read") && { "usage.read": usageSnapshot }),
		});
		const paths: Paths = { ...logicPaths(claudePaths(), stdin), override: OVERRIDE_PATH, data: DATA_DIR };
		const email =
			current.model && current.modelRegistry.authStorage.oauth.identity(current.model.provider, current.sessionManager.getSessionId())?.email;
		const { lines } = await renderStdin(stdin, hudConfig, {
			ask,
			files: true,
			paths,
			dataDir: DATA_DIR,
			now,
			columns,
			host: {
				transcript: { ...transcript, agents: agentsOf(current.getAsyncJobSnapshot(), spawns), todos: todosOf(todos) },
				counts,
				costTotals: costs,
				authInfo: email ? { method: null, user: email.split("@")[0], email } : null,
			},
		});
		lines.push(...problemLine(problems, columns));
		if (tickets.length) lines.push(`${RESET}${label("工人 ", hudConfig.colors)}${tickets.join(" ")}`);
		const filter = terminalFilter(stdin);
		const base = baseGray();
		return lines.map(line => `${PAD}${base}${filter(line).replaceAll(RESET, RESET + base)}${RESET}`);
	}

	function mount(current: ExtensionContext): void {
		ctx = current;
		if (!current.hasUI || current.mode !== "tui" || current.agent.kind !== "main") return;
		reloadConfig();
		renewProbes(current);
		current.ui.setWidget(
			WIDGET_KEY,
			host => {
				tui = host;
				return {
					render: terminalWidth => {
						if (terminalWidth !== width) {
							width = terminalWidth;
							refresh();
						}
						// 新宽度的结果算出来之前，旧结果按新宽度截断
						if (!output) return [];
						return output.width === terminalWidth ? output.lines : output.lines.map(line => truncateToWidth(line, terminalWidth));
					},
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
			renewProbes(ctx);
			void refreshUsage(ctx);
			void refreshWorkspace(ctx);
			void refreshTickets(ctx);
			void refreshCosts(ctx);
			void refreshCounts(ctx);
			// 闲置时缓存暖机会追加刷新记录，换模型也没有事件，靠这里重算
			refreshSession(ctx);
		}, TICK_MS);
		current.setInterval(() => {
			const busy = running.size > 0 || (ctx?.getAsyncJobSnapshot()?.running.length ?? 0) > 0;
			// 刚跑完的那一下也要重画，状态才会变成已完成
			if (busy || wasBusy) refresh();
			wasBusy = busy;
		}, LIVE_MS);
		refreshSession(current);
		void refreshWorkspace(current);
		void refreshTickets(current);
		void refreshCounts(current);
		void refreshUsage(current).then(() => refreshCosts(current));
	}

	pi.on("session_start", (_event, current) => mount(current));
	pi.on("session_switch", (_event, current) => {
		running.clear();
		spawns.clear();
		ctx = current;
		renewProbes(current);
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
		refresh();
	});
	pi.on("agent_end", (_event, current) => {
		running.clear();
		renewProbes(current);
		refreshSession(current);
		void refreshWorkspace(current);
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

	pi.on("message_end", (event, current) => {
		// 工具调用要等这则回复落盘后才查得到
		if (event.message.role === "assistant") refreshSession(current);
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
