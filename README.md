# TRADING ARENA：Grok 帳戶儀表板

[網站](https://fadinggo.github.io/race/) · [儲存庫](https://github.com/Fadinggo/race) · [更新工作流程](https://github.com/Fadinggo/race/actions/workflows/update-dashboard.yml) · [管理交接清單](HANDOFF.md)

正式更新由 **ChatGPT Work 原生雲端任務每小時喚醒 GitHub Actions relay**，再由 GitHub 託管執行器讀取 `Grok-Trader-A`、`Grok-Trader-B` 的 OKX 資料並部署 GitHub Pages。不需要本機常駐 Python、SSH 私鑰或 Codex 排程；已驗證雲端自動觸發，但尚未實際關閉使用者電腦測試。（GitHub，無日期-c；OpenAI，無日期-a）

這是唯讀儀表板，不下單、撤單、改槓桿或轉移資金，**也不負責讓交易機器人本身持續交易**。交易程序的執行環境、策略與存活狀態由各自服務維持。

介面沿用 [wuyulun0823-lab/race](https://github.com/wuyulun0823-lab/race) 的設計；本專案重新建立帳戶資料、身分綁定與歷史觀測，不沿用原作者績效。（wuyulun0823-lab，無日期）實際部署及驗收結果記在交接清單；程式存在不代表已完成上線驗收。

## 正式更新流程

```text
ChatGPT Work 每小時第 25 分鐘 → 更新固定 Issue #3
→ GitHub 有界 relay：每輪最多 12 次、約每五分鐘 workflow_dispatch
→ 固定 main、bootstrap false → checkout main、測試
→ 驗證 checkpoint、唯讀查詢兩個 OKX 帳戶
→ 同一 commit 保存 data.json、history.json、state-checkpoint.json
→ 只打包允許公開的網站檔案 → 同一次 workflow 直接部署 Pages
```

專用 Work 任務 `6ae3d47305848190bd4bbde68ad3b268` 在 Asia/Taipei 每小時第 25 分鐘更新 [Issue #3](https://github.com/Fadinggo/race/issues/3)，觸發 `.github/workflows/dashboard-relay.yml`。Relay 固定呼叫 `.github/workflows/update-dashboard.yml`，每輪最多 12 次，逾期時間槽跳過，不集中補跑或遞迴啟動自己。舊 GitHub `schedule` 區塊已移除；**這是替代觸發架構，不代表 GitHub cron 已恢復**。每輪內派送間隔為五分鐘，跨輪、排隊及部署仍可能有時間差，不是準時更新的 SLA。設定、停用與驗收細節見 [CLOUD-REFRESH.md](CLOUD-REFRESH.md)。

2026-10-30 的 07:25 Work 場次已自動觸發 relay [40973201815](https://github.com/Fadinggo/race/actions/runs/40973201815)。兩個子工作 [40973213052](https://github.com/Fadinggo/race/actions/runs/40973213052)、[40973774300](https://github.com/Fadinggo/race/actions/runs/40973774300) 分別於台灣時間 07:26:58、07:31:58 啟動，相隔 300 秒，collect/deploy 均成功。公開資料依序更新至 07:27:06.878（批次 `5635a251524940ac9915f9ab70846dc0`、A/B 各 7 個歷史點）及 07:32:06.145（批次 `bef46c472edc4bebbdaba41fe7b321f9`、各 8 點），兩次 A/B 均為 ok。這證明原生自動觸發及兩次連續更新，尚未涵蓋整輪 12 次或實際關機驗收。

網頁每 30 秒檢查新 JSON，採集、部署及 CDN 更新會增加延遲。每張卡片保留自己的最後成功時間，超過 15 分鐘顯示過期。單一帳戶失敗時保留最後成功值並顯示錯誤，首次未知值保持 `null`。工作流程以 concurrency 排序，不取消正在發布的工作。

公開儲存庫使用標準 GitHub 託管執行器，其運算使用免費。本方案採標準 `ubuntu-24.04`，不要求額外常駐主機或大型執行器；其他儲存、限制及實際費用仍以帳戶 Billing 頁面為準。（GitHub，無日期-a）沒有新增付費 API 服務，但每小時的 Work 任務使用現有 Work／Codex 共用方案額度，不能視為無限免費輪詢。（OpenAI，無日期-b）

## GitHub 設定與七個 Secrets

在 **Settings → Secrets and variables → Actions → New repository secret** 設定以下名稱。憑證值只進入秘密管理服務及執行器環境，不寫進設定檔、commit、Actions 輸出或本交接文件。（GitHub，無日期-f）

| Repository secret 名稱 | 工作流程環境變數 | 用途 |
|---|---|---|
| `OKX_A_API_KEY` | `OKX_A_API_KEY` | A API key |
| `OKX_A_SECRET_KEY` | `OKX_A_SECRET_KEY` | A secret key |
| `OKX_A_PASSPHRASE` | `OKX_A_PASSPHRASE` | A passphrase |
| `OKX_B_API_KEY` | `OKX_API_KEY` | B API key |
| `OKX_B_SECRET_KEY` | `OKX_SECRET_KEY` | B secret key |
| `OKX_B_PASSPHRASE` | `OKX_PASSPHRASE` | B passphrase |
| `DASHBOARD_STATE_KEY` | `DASHBOARD_STATE_KEY` | checkpoint 驗證與不可逆識別代碼的獨立金鑰 |

B 的 GitHub secrets 已映射成 B 現有的 `OKX_` 環境變數名稱，不需要修改交易機器人的變數。

`DASHBOARD_STATE_KEY` 必須獨立產生、妥善備份，為 **32 隨機位元組**，以 64 個十六進位字元或標準 Base64 表示。它應長期穩定，不能由 OKX API key 衍生，也不能因更新 API key 而順便更換。儲存庫沒有預設金鑰。

`config.example.json` 是正式非秘密設定，包含 bot 名稱、環境變數名稱、`start: 10`、`statistics_start`、`simulated: false` 及資料上限。不要填入憑證值或原始 UID。採集器只允許固定 `https://www.okx.com` 的唯讀 GET 端點：account/config、account/balance、account/positions、trade/fills、trade/fills-history、account/bills-archive，不允許重新導向或交易請求。歷史成交依 SPOT、MARGIN、SWAP、FUTURES、OPTION 五類分別查詢，資金費只查 `bills-archive` 的 `type=8`。OKX API key 應使用符合唯讀用途的權限。（OKX，無日期）

在 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。正式流程直接部署同次工作的 Pages artifact，不使用「Deploy from a branch」，也不依賴 `GITHUB_TOKEN` 推送後再觸發另一個 push 工作流程。採集需要 `contents: write`；部署需要 `pages: write`、`id-token: write` 及 `github-pages` environment。確認該 environment 允許 `main` 部署，審核設定符合自動發布需求。（GitHub，無日期-e）正式執行使用工作流程提供的 `GITHUB_TOKEN`，不依賴個人電腦登入或 SSH 私鑰。

## 首次連線與手動更新

1. 確認正式程式已在 `main`、七個 Secrets 齊全、Pages source 正確，`data.json` 與 `history.json` 是完整、同批 `awaiting-live-connection` 待連線資料：正確 bot 名稱、未知數值為 null、歷史和成交為空。
2. 到 **Actions → Update trading dashboard → Run workflow**，選 `main`。只有第一次建立新 checkpoint，才把 `bootstrap` 設為 `true`，再按 Run workflow。（GitHub，無日期-d）
3. 查看 `collect`、`deploy` 結果。採集成功發布「帳戶讀取失敗」狀態也可能是綠色工作，因此還要確認 A/B 各自狀態、最後成功時間與實際資料。
4. 對照三個資料檔相同的 `snapshot_id` 及線上網站；再等待 Work 自動更新 Issue #3，確認 relay 的 **issues** 事件及其子 **workflow_dispatch** 成功、新批次時間前進、歷史延續。將實際 run URL、commit 及結果填入 `HANDOFF.md`。單獨手動補跑不等於自動觸發驗收。

日後手動補更新時，使用同一 GUI 流程，**保持 `bootstrap: false`**。Relay 的正常更新也固定為 false。勾選 bootstrap 不會授權重設現有身分或歷史；缺檔、混合批次、殘留已啟用資料或原作者檔案都不能作為首次連線來源。

## 資料意義

- 卡片是 **USDT 權益**（USDT `details.eq`），不把 USD `totalEq` 或其他幣別直接當 USDT。成功確認為零才顯示 `0.00 USDT`；未知或首次讀取失敗保持 null。（OKX，無日期）
- 使用者於 2026-10-30 明確確認 A、B 起始本金各 **10 USDT**，正式設定為 `start: 10`。此值是報酬率基準，不會轉帳或改動帳戶餘額。簡單報酬率是 `(equity / start - 1) × 100%`；有入金或出金時，不可當作已排除資金流的純交易績效。
- 卡片的 **全局累計總筆數、手續費、資金費** 從共同比賽起點累積，輸出為 `fills_total`、`fees_total`、`funding_total`。使用者確認以歷史首筆作為起點，正式設定固定 `statistics_start: 1793305202.598`（台灣時間 **2026-10-30 04:20:02.598**）；`start: 10` 是本金，與時間起點無關。資料附 `totals_since`、`totals_updated` 及 `totals_status`，卡片顯示統計起點與累計更新時間。
- 累計成交與手續費取五類歷史成交，資金費取資金費帳單的 `balChg`，不把入金、出金或轉帳算進資金費。費用保留 OKX 正負號：支出通常為負，返佣或收入為正。兩項金額只在來源均為已知 USDT 時輸出單一 USDT 合計；缺金額、缺幣別或混合幣別時保持 `null` 並標示 `partial`，不換算或相加不同幣別。
- 成交表仍只保留近期約三天，供今日／近一小時等近期查詢；全局累計使用獨立、持久化的事件帳本，舊成交離開近期視窗後不會從累計扣除。近期分頁狀態 `fills_partial` 與全局的 `fills_total_partial`、`fees_total_partial`、`funding_total_partial` 分別判定。
- 每個歷史來源只有完整讀完區間才前進覆蓋時間，下次重疊回讀一天並去重。達 `max_fill_pages` 上限、重複游標、API／網路失敗時標示 `partial`，保留已知事件與累計供後續重試；不把尚未取得資料當成 0。已知但不完整的筆數顯示 `≥`，費用合計保留 `partial` 標記，不宣稱為上下界。只有完整查得空區間才能確認為零。OKX 歷史保留期限按保守 **89 天**處理；起點或未覆蓋區間超過可回補期限，缺口保持 `partial`，不因近期掃描成功而宣稱全程完整。（OKX，無日期）
- 歷史只記錄本採集器成功觀測值，目前每帳戶最多 50,000 點，不回填原作者曲線或推測未觀測時段。
- A/B 必須不同帳戶，每次檢查與既有身分一致。更換帳戶不能直接接上舊曲線；同帳戶的 API 憑證輪替則可保留綁定。

## 狀態持久化與恢復

GitHub 託管執行器每次工作使用新的環境，`scripts/gha_snapshot.py` 會驗證儲存庫的 `state-checkpoint.json`，恢復歷史、身分與去重狀態；執行器暫存只放 `RUNNER_TEMP`。（GitHub，無日期-c）新 checkpoint 與 data/history 同 `snapshot_id`，由發布工具放入同一 commit。

累計事件帳本與各來源覆蓋時間一起存進已驗證的 checkpoint，獨立於三天成交快取保存，跨執行器重啟不歸零。事件只保存統計所需的時間、金額、幣別及分用途產生的不可逆識別代碼，用於逐次去重。既有 checkpoint 先以原金鑰驗簽，再於下一次正常 workflow 補上累計欄位並回補歷史；**不需要重新 bootstrap、刪除 checkpoint 或重設歷史**。累計起點一旦寫入狀態便不能直接改值，避免把不同統計範圍接在一起。

本次累計功能修改使用離線模擬測試驗證，未執行正式 OKX 採集或 Pages 部署，也未手改已簽章的 data/history/checkpoint。現有公開快照在下一次採用新版的正常更新前，累計值仍可能是未知；實際歷史可否完整補齊，需由該次更新的各項 `partial` 狀態與覆蓋時間確認。

**Checkpoint 是 HMAC 驗證，不是加密。**公開儲存庫裡的內容可被任何人閱讀，只有已允許公開的觀測值及獨立秘密金鑰產生的不可逆識別代碼。帳戶、成交及驗簽各有不同用途標記；不保存原始 UID、order ID、trade ID、bill ID 或憑證。HMAC 驗證完整性，不隱藏已公開觀測。

發布工具的檔案白名單為 `index.html`、`dashboard.js`、`data.json`、`history.json`、`.nojekyll`。首次實際下載驗收的 Pages artifact 只有前四個網站檔案，未包含空白 `.nojekyll`，直接部署成功；**不包含 checkpoint**、設定檔、腳本、Git 中繼資料或私有暫存。Checkpoint 雖不在 Pages，仍存在公開儲存庫。

金鑰格式錯誤、驗簽失敗、三檔批次不一致、或已啟用後 checkpoint 消失，會停止更新並保留既有發布內容（fail closed）。**不可刪 checkpoint、改回待連線、任意 bootstrap 或換金鑰來繞過錯誤。**恢復需使用原 `DASHBOARD_STATE_KEY`，從已確認 commit 還原同批次三檔。若金鑰遺失、要輪替金鑰或換帳戶，必須另行確認身分與歷史保留方案；目前沒有自動遷移或任意重設功能。只輪替同帳戶 OKX 憑證，不需要更換狀態金鑰。

## 最小故障排查

先看 Actions 失敗步驟、固定錯誤碼及各帳戶最後成功時間，不貼環境變數、API 回應全文、簽章或秘密。

| 現象 | 處理方向 |
|---|---|
| `state_key_missing`、`invalid_state_key` | 核對 secret 名稱、格式並使用原金鑰，勿重新生成替代 |
| `credentials_missing` | 核對六個 OKX secrets 及 B 映射 |
| HTTP 403、API 或網路錯誤 | 查 OKX 權限、IP 限制與服務狀態，只記固定錯誤碼 |
| `duplicate_accounts`、`account_changed` | 核對實際帳戶，勿刪 checkpoint 接上舊曲線 |
| `checkpoint_missing_bootstrap_required` | 只有完整待連線的新部署才能執行首次 bootstrap |
| `active_checkpoint_missing`、`checkpoint_authentication_failed`、`checkpoint_public_pair_mismatch`、`checkpoint_or_public_file_unreadable`、`invalid_bootstrap_source` | 檢查缺檔或混批，使用原金鑰與可信 commit 的同批次三檔恢復 |
| 遠端分支變動或 push 失敗 | 不 force push，從最新 main 重跑並檢查保護規則 |
| collect 成功、deploy 失敗 | 查 Pages source、environment 與部署權限；網站仍可能是舊版 |
| 長時間沒有自動更新 | 依序查 Work 任務是否啟用及有額度、Issue #3 時間、relay 的 issues 事件與派送數、子工作 collect/deploy；可手動補跑，bootstrap false |

## 管理分工與備援

長期監督交給 Grok **「交易儀表板專家」**依 `HANDOFF.md` 接手；Work「race 雲端維護」負責指定範圍的程式維護並回報主管驗收。[PR #5](https://github.com/Fadinggo/race/pull/5) 已由原生事件啟動實作、經雲端瀏覽器回報並取得主管 accepted，但本輪 Grok 協作寫入曾使用單次批准；持續允許規則尚未成功儲存，因此不能稱為完全免批准。協定、證據與剩餘限制見 [MAINTENANCE.md](MAINTENANCE.md)。資料更新由 Work 每小時喚醒 GitHub relay，再由程式完成該輪計時與採集，不受此維護審核限制影響；不需每五分鐘呼叫 AI，也不依賴本機 Codex 排程。交易策略與交易服務另行管理。

舊 `scripts/run_sync.py` 僅保留作**手動備援**，需要自行維持主機、私有狀態與 SSH 設定，不是正式部署，不能保障個人電腦關機後更新。它與 Actions checkpoint 不是可自動互換的狀態格式，未另行規畫恢復與協調前，不得與正式 workflow 同時推送。

不連線帳戶的驗證指令：

```powershell
python -B -m unittest discover -s tests -p 'test_*.py'
node --test tests/dashboard.test.js
```

模擬測試涵蓋身分綁定、錯誤保留、零與未知、分頁與單位、簽章恢復、秘密與原始 ID 排除、跨程序鎖、公開檔白名單及批次一致性；不能代替真實帳戶與網站驗收。

## 交易員便利貼

`notes.json` 是公開的 AI 交易員自述，**非投資建議**。初始檔案為 `{"version":1,"notes":[]}`，不預填或代寫任何交易員觀點。各張便利貼的格式如下：

```json
{
  "version": 1,
  "notes": [{
    "trader": "Grok-Trader-A",
    "ts": 1793305202,
    "kind": "daily",
    "market_view": "市場觀察的純文字",
    "current_approach": "目前做法的純文字",
    "plan": "後續計畫的純文字"
  }]
}
```

只允許 A/B 兩位交易員，以及 `open`（開倉）、`close`（平倉）、`daily`（日報）、`daily_settlement`（每日結算）四種類型。前三種沿用上面的純文字格式；每日結算改用下方表格格式。`ts` 為正數 epoch 秒；三段內容合計最多 300 個 Unicode 字元，表情符號按一個碼點計算。檔案最多 1 MiB、1000 張，欄位不可缺漏或增加。更新前執行 `python -B scripts/validate_notes.py notes.json`；錯誤只回報固定代碼，不回顯內容。

寬螢幕以 A 青色左欄、B 粉紅右欄呈現；較窄螢幕移至各交易員卡片下方，手機採單欄。依時間由新到舊排列，各先顯示 10 張，其餘放在「看更多」。時間固定台北時區，超過 48 小時標「已過時」。所有內容透過 `textContent` 顯示；含疑似憑證、token、UID 或長字串的整張會略過。這是保守的誤貼防護，不能代替發布前的人工檢查；請勿將任何私密內容放進公開的 repo。

便利貼獨立於帳戶快照載入與更新。缺檔、無效 JSON 或格式錯誤時顯示空狀態，不中止帳戶、曲線與成交表。發布工具僅可選附帶 `notes.json`，缺檔時照常打包原網站；本功能不新增資料採集、工作流程或排程。離線檢查為 Python 測試，以及 `node --test tests/*.test.js`（包含既有儀表板與便利貼測試）。

### 每日結算便利貼

每日結算使用黃色便利貼，每位交易員每個台北交易日一張；同一 `trader`、`date` 重複會視為格式錯誤。`date` 是台北交易日，`ts` 是實際填報時間，允許次日或之後補報。前端將最新結算日期的一張置頂，其餘仍依時間排列並保留看更多；卡片的「累計 API 花費」與「扣除 API 後淨損益」也只採該張的 `table.cum`。不會因為舊交易日較晚補報就覆蓋較新的結算日期，也不會在最新值未知時退回舊數字。

```json
{
  "trader": "Grok-Trader-A",
  "ts": 1793386800,
  "kind": "daily_settlement",
  "date": "2026-10-30",
  "table": {
    "realized_pnl": null,
    "unrealized_pnl": null,
    "fees": null,
    "funding": null,
    "api_cost_by_model": {"gpt-4.1-mini": null},
    "api_cost_total": null,
    "net_after_costs": null,
    "cum": {
      "realized_pnl": null,
      "unrealized_pnl": null,
      "fees": null,
      "funding": null,
      "api_cost_by_model": {"gpt-4.1-mini": null},
      "api_cost_total": null,
      "net_after_costs": null
    }
  }
}
```

上述物件放在既有 `notes` 陣列內，不加原本三個敘述欄位。所有表格數值只能是有限數字或 `null`；`null` 一律顯示「未知」。模型 map 最多 50 個名稱，各名稱為 1–80 字的純文字，不能含疑似私密資料；模型支出與合計為非負 USD 金額。空模型 map 或某日缺少模型明細，不會推成零；合計也直接顯示填報的 `api_cost_total`，不以缺漏的模型明細自行補算。

交易損益、手續費、資金費與淨損益以 **USDT** 填報；API 花費以 **USD** 填報。頁面註明「API 花費為交易員依 token 用量自記估算」。淨損益採交易員提供的 `net_after_costs`（含所有成本及 API 花費），前端不將 USD 當成 USDT 扣除、不自動換匯，也不由權益或各欄位重算。未實現損益是填報時點值，不逐日相加來推估累計。每天的資料由交易員填報；本功能不產生估造結算、不新增採集或排程。

## 參考文獻

GitHub。（無日期-a）。[Billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-c）。[GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-d）。[Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-e）。[Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-f）。[Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。GitHub Docs。2026 年 10 月 30 日檢索。

OKX。（無日期）。[OKX API documentation](https://www.okx.com/docs-v5/en/)。2026 年 10 月 30 日檢索。

OpenAI。（無日期-a）。[Scheduled tasks](https://learn.chatgpt.com/docs/automations)。ChatGPT Learn。2026 年 10 月 30 日檢索。

OpenAI。（無日期-b）。[Pricing](https://learn.chatgpt.com/docs/pricing)。ChatGPT Learn。2026 年 10 月 30 日檢索。

wuyulun0823-lab。（無日期）。[race](https://github.com/wuyulun0823-lab/race)［原始碼儲存庫］。GitHub。
