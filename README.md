# omp-hud

[Claude HUD](https://github.com/jarrodwatts/claude-hud) 移植到 [Oh My Pi](https://omp.sh)（`omp`）：在輸入框下方常駐顯示，畫面、配置、語言都與 Claude HUD 相同。

```
[Claude Opus 5.5 ◔ medium] │ my-project git:(main* [+27 -3]) │ 會話名稱 │ ⏱️  1h 0m │ 費用 $0.167 | 今日 $12.40 | 本週 $48.90 │ 輸出: 174.4 tok/s │ user
上下文 █░░░░░░░░░ 5%
用量   █░░░░░░░░░ 91% (重置剩餘 2h 32m, Nov 17 00:39) | 本週   █████░░░░░ 50% (重置剩餘 1d 14h, Nov 18 12:59)
Fable ███░░░░░░░ 67% (重置剩餘 1d 14h, Nov 18 12:59)
快取 ⏱ 至 23:08
快取命中 92.2%
2 CLAUDE.md | 7 MCPs | 3 Hook
✓ read ×1
✓ Skills (1): brainstorming
▸ 甲 (0/2)
```

## 怎麼移植的

- `vendor/claude-hud/` 是 Claude HUD 原始碼，未改一字（MIT，見其中 `LICENSE`）。渲染、配置解析、git 狀態解析、記憶體換算都直接呼叫它。
- `src/claude-hud.ts` 把 OMP 的資料轉成 Claude HUD 的輸入：Claude Code 交給 statusline 的 stdin、transcript 解析結果、git 探針。
- 同步上游：用新版的 `src` 整個覆蓋 `vendor/claude-hud/src`，重開 omp。

## 配置

- 與 Claude Code 共用 `~/.claude/plugins/claude-hud/config.json`（`CLAUDE_CONFIG_DIR` 同樣生效），在 Claude Code 裡用 `/hud` 改的設定兩邊一起變。
- 只想在 omp 生效的設定寫進 `~/.omp/agent/omp-hud.json`，鍵逐個蓋過上面的 config.json，格式相同。
- 每 30 秒重讀一次配置，不用重開。

## 資料對應

| Claude HUD 項目 | omp 的來源 |
|---|---|
| 模型、思考強度、會話名稱、時長、費用 | 當前模型、`pi.getThinkingLevel()`、會話名稱、會話建立時刻、`getUsageStatistics().cost` |
| 上下文 | `ctx.getContextUsage()` |
| 額度（5 小時、本週、分模型每週） | `authStorage.usage.reports()` 中當前模型那家、這個會話所用帳號的限額 |
| 提示快取到期、命中率 | 照 OMP 狀態列 `cache` 段的推算（含閒置暖機刷新）；命中率為會話累計 |
| 生成速度 | 最近一則回覆：輸出 token ÷ 首個增量到結束的時間 |
| 今日／本週費用 | 掃 `~/.omp/agent/sessions` 下的會話檔，只重讀有改動的檔案 |
| 工具、技能、MCP、待辦、Token、壓縮次數、上次回覆 | 當前會話分支；技能取 `read skill://…`，MCP 含經 `xd://` 裝置的呼叫 |
| 子代理 | `task` 的背景作業，類型與模型取自派發參數 |
| 環境計數 | CLAUDE.md：從 cwd 往上到家目錄，以及 `~/.omp/agent` 下的 AGENTS.md、CLAUDE.md；MCPs：已連上的 MCP 伺服器；Hook：`~/.omp/agent/extensions` 下的擴充 |
| git、記憶體 | 照 Claude HUD collector 的同一組 git 與 `vm_stat` 指令執行，交給它自己解析 |

額度每 30 秒和每輪回覆後各讀一次。OMP 會把每次回覆的限額響應頭並入快取（最多每分鐘一次），所以數字跟著對話走；只有快取過期（每帳號 5 分鐘）時 OMP 才打上游。

沒有對應、因此不顯示的：顧問（OMP 未開 advisor）、Claude Code 版本、輸出風格。Claude HUD 只顯示一家訂閱，所以只顯示當前模型那家；Codex 等其他訂閱看 `/usage`。

工單工人進度（`_tickets/doing`）是 omp-hud 自己加的一行，接在 Claude HUD 各行之後。

## 安裝

需求：omp 18.20 以上（`ctx.ui.setWidget(..., { placement: "belowEditor" })`）。

```bash
git clone https://github.com/20156284/omp-hud ~/project/omp-hud
mkdir -p ~/.omp/agent/extensions
ln -sfn ~/project/omp-hud ~/.omp/agent/extensions/omp-hud
```

改了 omp-hud 的程式碼要重開 omp 才生效（`omp -c` 可接回原會話）；只改配置不用。

## 停用與卸載

- 暫時停用：`rm ~/.omp/agent/extensions/omp-hud`（只刪符號連結，專案原始碼不受影響），重開 omp。
- 恢復原生額度欄位：在 `~/.omp/agent/config.yml` 的 `statusLine.rightSegments` 末尾加回 `- usage`。

## 授權

MIT。`vendor/claude-hud` 沿用其上游 MIT 授權。
