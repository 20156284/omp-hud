# omp-hud

[Claude HUD](https://github.com/jarrodwatts/claude-hud) 的 fork，給 [Oh My Pi](https://omp.sh)（`omp`）用：在輸入框下方常駐顯示，畫面、配色、配置、語言都與 Claude Code 裡的 Claude HUD 相同。

## 怎麼做的

倉庫根目錄是上游 Claude HUD 原樣的代碼，omp 的部分都在 `omp/`。

- `omp/omp-hud.ts` 是擴充入口兼 omp 宿主，作用相當於 Claude Code 這一側的 `hud.mjs`：照 Claude Code 的格式組裝 stdin，用上游 `collector.mjs` 的 `createProbes` 跑 git 與記憶體探針，呼叫上游 `src/main.ts` 的 `renderStdin` 完成整次渲染，輸出經上游 `terminalFilter` 過濾。
- 入口檔名就是擴充名：omp 用檔名推導擴充名並按名字去重，同名的擴充只會載入一個（例如叫 `extension.ts` 會和 `extension/index.ts` 撞名）。
- Claude Code 顯示 statusline 時會把無色文字染成主題的 inactive 灰（深色背景 `#999999`、淺色背景 `#666666`），左右各留 2 列；宿主照做，配色與 Claude Code 逐字一致。
- 上游只改了 `src/main.ts`：`await main()` 在被 import 時不執行；`renderStdin` 的 `Sources.host` 讓宿主直接提供 transcript、環境計數、費用與帳號，不去讀 Claude Code 的檔案。

## 資料對應

| Claude HUD 項目 | omp 的來源 |
|---|---|
| 模型、思考強度、會話名稱、時長、會話費用 | 當前模型、`pi.getThinkingLevel()`、會話名稱、會話建立時刻、`getUsageStatistics().cost` |
| 上下文 | `ctx.getContextUsage()`；Token 明細取最近一則回覆的用量，壓縮後清空 |
| 額度 5 小時、本週 | stdin `rate_limits`，取自 `authStorage.usage.reports()` 中當前模型那家、這個會話所用帳號的限額 |
| 分模型每週額度（如 Fable） | 經 `usage.read` 探針交給上游的外部額度快照合併 |
| 生成速度 | 上游 `speed.ts`：最近一則回覆的輸出 ÷ 它增加的 API 時長（從首個增量算起） |
| 提示快取到期、命中率 | 照 omp 狀態列 `cache` 段的推算（含閒置暖機刷新）；命中率為會話累計 |
| 今日／本週費用 | 掃 `~/.omp/agent/sessions` 下的會話檔；本週口徑照 `display.weeklyCostPeriod` |
| 工具、技能、MCP、待辦、Token、壓縮次數、上次回覆 | 當前會話分支；技能取 `read skill://…`，MCP 含經 `xd://` 裝置的呼叫 |
| 子代理 | `task` 的背景作業，類型與模型取自派發參數 |
| 環境計數 | CLAUDE.md：從 cwd 往上到家目錄，以及 `~/.omp/agent` 下的 AGENTS.md、CLAUDE.md；MCPs：已連上的 MCP 伺服器；Hook：`~/.omp/agent/extensions` 下的擴充 |
| git、記憶體、工作樹、倉庫連結 | 上游探針；工作樹名與 origin 倉庫自己查 |

沒有對應、因此不顯示的：顧問、Claude Code 版本、輸出風格。Claude HUD 只顯示一家訂閱，所以只顯示當前模型那家；其他訂閱看 `/usage`。

工單工人進度（`_tickets/doing`）是 omp-hud 自己加的一行，接在 Claude HUD 各行之後。

## 配置

- 與 Claude Code 共用 `~/.claude/plugins/claude-hud/config.json`（`CLAUDE_CONFIG_DIR` 同樣生效），在 Claude Code 裡用 `/hud` 改的設定兩邊一起變。
- 只想在 omp 生效的設定寫進 `~/.omp/agent/omp-hud.json`，鍵逐個蓋過上面的 config.json，格式相同。
- 每 30 秒重讀一次配置，不用重開。

## 安裝

需求：omp 18.20 以上（`ctx.ui.setWidget(..., { placement: "belowEditor" })`）。

```bash
git clone https://github.com/20156284/omp-hud ~/project/omp-hud
mkdir -p ~/.omp/agent/extensions
ln -sfn ~/project/omp-hud/omp ~/.omp/agent/extensions/omp-hud
```

改了程式碼要在 omp 裡輸入 `/restart` 才生效（沿用原啟動參數並接回當前會話）；只改配置不用。

## 同步上游

倉庫沒有接上游的 git 歷史，同步時用上游新版整包覆蓋（不含 `.git`、`.github` 與 `omp/`），再把 `src/main.ts` 的改動補回：

```bash
git clone --depth 1 https://github.com/jarrodwatts/claude-hud .tmp/claude-hud
rsync -a --exclude .git --exclude .github --exclude omp .tmp/claude-hud/ ./
git diff src/main.ts   # 對照被覆蓋掉的改動補回
```

`src/main.ts` 的改動：`AuthInfo`、`CostTotals` 類型導入；`Sources.host` 與 `HostData`；`renderStdin` 裡 transcript、環境計數、費用、帳號改取宿主資料；`problemLine` 導出；末尾 `await main()` 加 `import.meta.main` 判斷。

## 停用

`rm ~/.omp/agent/extensions/omp-hud`（只刪符號連結），重開 omp。
