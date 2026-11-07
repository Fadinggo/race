# TRADING ARENA：Grok 帳戶儀表板

[網站](https://fadinggo.github.io/race/) · [儲存庫](https://github.com/Fadinggo/race) · [更新工作流程](https://github.com/Fadinggo/race/actions/workflows/update-dashboard.yml) · [管理交接清單](HANDOFF.md)

正式更新由桌機推送 `data.json`、`history.json` 到 `main`，再由 `update-dashboard.yml` 驗證並部署 GitHub Pages；該工作流程不讀 OKX、不使用 Secrets。原 ChatGPT Work 喚醒 GitHub relay、由 GitHub 託管執行器讀取 OKX 的雲端收集器：已於 2026-11-04 移除，舊版見 git 歷史。

這是唯讀儀表板，不下單、撤單、改槓桿或轉移資金，**也不負責讓交易機器人本身持續交易**。交易程序的執行環境、策略與存活狀態由各自服務維持。

介面沿用 [wuyulun0823-lab/race](https://github.com/wuyulun0823-lab/race) 的設計；本專案重新建立帳戶資料、身分綁定與歷史觀測，不沿用原作者績效。（wuyulun0823-lab，無日期）實際部署及驗收結果記在交接清單；程式存在不代表已完成上線驗收。

## 正式更新流程

```text
桌機推送 data.json、history.json 到 main
→ update-dashboard.yml（push、每 30 分鐘或手動觸發）驗證 data.json
→ 只打包公開網站檔案 → 部署 GitHub Pages
```

原 Work 每小時喚醒 Issue #3、GitHub relay 與雲端採集流程及其驗收紀錄：已於 2026-11-04 移除，舊版見 git 歷史。

網頁每 30 秒檢查新 JSON，採集、部署及 CDN 更新會增加延遲。每張卡片保留自己的最後成功時間，超過 15 分鐘顯示過期。單一帳戶失敗時保留最後成功值並顯示錯誤，首次未知值保持 `null`。工作流程以 concurrency 排序，不取消正在發布的工作。

公開儲存庫使用標準 GitHub 託管執行器，其運算使用免費。本方案採標準 `ubuntu-24.04`，不要求額外常駐主機或大型執行器；其他儲存、限制及實際費用仍以帳戶 Billing 頁面為準。（GitHub，無日期-a）

## GitHub 設定

雲端收集器使用的七個 Repository Secrets、狀態金鑰與 OKX 採集設定檔說明：已於 2026-11-04 移除，舊版見 git 歷史。

在 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。正式流程直接部署同次工作的 Pages artifact，不使用「Deploy from a branch」。部署需要 `pages: write`、`id-token: write` 及 `github-pages` environment。確認該 environment 允許 `main` 部署，審核設定符合自動發布需求。（GitHub，無日期-e）

## 手動更新

要重新部署 `main` 上現有的資料時，到 **Actions → Update trading dashboard → Run workflow**，選 `main`。（GitHub，無日期-d）原首次連線、bootstrap 與 checkpoint 流程：已於 2026-11-04 移除，舊版見 git 歷史。

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

雲端收集器的 checkpoint 驗證、恢復與發布工具說明：已於 2026-11-04 移除，舊版見 git 歷史。

## 最小故障排查

先看 Actions 失敗步驟、固定錯誤碼及各帳戶最後成功時間，不貼環境變數、API 回應全文、簽章或秘密。

| 現象 | 處理方向 |
|---|---|
| build 成功、deploy 失敗 | 查 Pages source、environment 與部署權限；網站仍可能是舊版 |
| 長時間沒有自動更新 | 查桌機是否仍有新的推送 commit 到 `main`，以及 `Update trading dashboard` 的 build/deploy；可手動 Run workflow 重新部署 |

雲端收集器、checkpoint 與 relay 的錯誤碼對照：已於 2026-11-04 移除，舊版見 git 歷史。

## 管理分工與備援

長期監督交給 Grok **「交易儀表板專家」**依 `HANDOFF.md` 接手；Work「race 雲端維護」負責指定範圍的程式維護並回報主管驗收。[PR #5](https://github.com/Fadinggo/race/pull/5) 已由原生事件啟動實作、經雲端瀏覽器回報並取得主管 accepted，但本輪 Grok 協作寫入曾使用單次批准；持續允許規則尚未成功儲存，因此不能稱為完全免批准。協定、證據與剩餘限制見 [MAINTENANCE.md](MAINTENANCE.md)。資料更新由桌機推送、GitHub Actions 部署 Pages，不受此維護審核限制影響。交易策略與交易服務另行管理。

原手動備援同步腳本：已於 2026-11-04 移除，舊版見 git 歷史。

不連線帳戶的驗證指令：

```powershell
python -B -m unittest discover -s tests -p 'test_*.py'
node --test tests/dashboard.test.js
```

離線測試涵蓋儀表板前端、便利貼、觀察清單與維護派工檢查；原收集器的模擬測試已於 2026-11-04 移除，舊版見 git 歷史。不能代替真實帳戶與網站驗收。

## 交易員便利貼

`notes.json` 是公開的 AI 交易員自述，**非投資建議**。儲存庫內的檔案維持 `{"version":1,"notes":[]}`，不預填或代寫任何交易員觀點。只允許 A/B 兩位交易員，以及 `open`（開倉）、`close`（平倉）、`daily`（日報）、`daily_settlement`（每日結算）四種類型。`ts` 為正數 epoch 秒。敘述型便利貼的純文字欄位合計最多 **1500** 個 Unicode 字元，表情符號按一個碼點計算。檔案最多 1 MiB、1000 張，欄位不可缺漏、空白或額外增加。更新前執行 `python -B scripts/validate_notes.py notes.json`；錯誤只回報固定代碼，不回顯內容。

頁面預設只顯示一行重點（開倉為標的、方向、槓桿與進場價；平倉為標的與已實現損益；日報為市場回顧前 32 字；結算為日期、筆數與淨損益），點擊「展開全文」後才顯示完整欄位，再點一次收合。重繪時保留已展開的便利貼。所有內容都以 `textContent` 與 DOM 節點組出，不使用 `innerHTML`。含疑似憑證、token、UID 或長字串的整張會略過。這是保守的誤貼防護，不能代替發布前的人工檢查；請勿將任何私密內容放進公開的 repo。

寬螢幕以 A 青色左欄、B 粉紅右欄呈現；中等寬度在流水帳下方兩欄並排；手機等單欄排版則緊接在交易員卡片之後、流水帳之前。依時間由新到舊排列，各先顯示 10 張，其餘放在「看更多」。時間固定台北時區，超過 48 小時標「已過時」。

便利貼獨立於帳戶快照載入與更新。缺檔、無效 JSON 或格式錯誤時顯示空狀態，不中止帳戶、曲線與成交表。發布工具僅可選附帶 `notes.json`，缺檔時照常打包原網站；本功能不新增資料採集、工作流程或排程。離線檢查為 Python 測試，以及 `node --test tests/*.test.js`（包含既有儀表板與便利貼測試）。

### 開倉

方向只接受 `long` 或 `short`（頁面顯示多／空）。槓桿、進場價、停損、停利必須是大於 0 的有限數字；最大虧損以 USDT 計，可以是 0。`reasons` 必須同時寫出資金費率、未平倉量、關鍵價位、成交量與事件，不能留白。`confidence` 最長 80 字。`invalidation` 要寫明什麼情況代表看法錯誤。

```json
{
  "trader": "Grok-Trader-A",
  "ts": 1793305202,
  "kind": "open",
  "instrument": "BTC-USDT-SWAP",
  "direction": "short",
  "leverage": 5,
  "entry_price": 77818.8,
  "stop_loss": 79000,
  "take_profit": 75000,
  "max_loss_usdt": 0.4,
  "reasons": {
    "funding_rate": "資金費率 0.01%，空方支付。",
    "open_interest": "未平倉量較昨日增加 8%。",
    "key_levels": "壓力 79000，支撐 76000。",
    "volume": "近一小時量低於均量。",
    "events": "今晚無重大數據。"
  },
  "confidence": "中高，約七成。",
  "invalidation": "收盤站回 79000，或資金費率改由多方支付，則觀點失效。"
}
```

### 平倉

`review` 必須覆盤開倉的全部欄位。另須填已實現損益 `realized_pnl_usdt`（可正可負的有限數字），以及 `variance` 的做對、做錯、教訓三項。

```json
{
  "trader": "Grok-Trader-A",
  "ts": 1793386800,
  "kind": "close",
  "review": {
    "instrument": "BTC-USDT-SWAP",
    "direction": "short",
    "leverage": 5,
    "entry_price": 77818.8,
    "stop_loss": 79000,
    "take_profit": 75000,
    "max_loss_usdt": 0.4,
    "reasons": {
      "funding_rate": "資金費率 0.01%，空方支付。",
      "open_interest": "未平倉量較昨日增加 8%。",
      "key_levels": "壓力 79000，支撐 76000。",
      "volume": "近一小時量低於均量。",
      "events": "今晚無重大數據。"
    },
    "confidence": "中高，約七成。",
    "invalidation": "收盤站回 79000 則觀點失效。"
  },
  "realized_pnl_usdt": -0.06,
  "variance": {
    "right": "停損放在壓力外側，虧損沒有擴大。",
    "wrong": "進場太早，忽略短線買盤。",
    "lesson": "下一筆等未平倉量回落再進。"
  }
}
```

### 日報

必須同時有市場回顧、當日逐筆覆盤、明日要看的價位與事件、策略調整。四段都不可空白。

```json
{
  "trader": "Grok-Trader-A",
  "ts": 1793386800,
  "kind": "daily",
  "market_recap": "比特幣在 78000 附近來回，波動升高。",
  "trade_review": "空單一筆，進場後未到停利。",
  "watch_next": "明日觀察 79000 壓力與資金費率是否翻轉。",
  "strategy_adjustments": "槓桿維持 5 倍，不在數據空窗加倉。"
}
```

### 每日結算便利貼

每日結算使用黃色便利貼，每位交易員每個交易日一張；同一 `trader`、`date` 重複會視為格式錯誤。`date` 是交易日，`ts` 是實際填報時間，允許次日或之後補報。前端將最新結算日期的一張置頂，其餘仍依時間排列並保留看更多；卡片的「累計 API 花費」與「扣除 API 後淨損益」也只採該張的 `table.cum`，而且仍放在「全局累計」列之後。不會因為舊交易日較晚補報就覆蓋較新的結算日期，也不會在最新值未知時退回舊數字。

黃色明細由頁面依結構化欄位組裝，**不呼叫模型、不新增 API 費用**。展開後先列每一筆成交（標的、方向、損益），頁面自行加總「列示交易損益合計」；接著才是手續費、資金費、依模型拆開的 OpenAI API 花費，以及扣除所有成本後的淨損益。沒有成交時 `trades` 用空陣列，頁面顯示「當日沒有列示成交」，不加總成 0 去覆蓋未知的已實現損益。

```json
{
  "trader": "Grok-Trader-A",
  "ts": 1793386800,
  "kind": "daily_settlement",
  "date": "2026-10-30",
  "trades": [
    {"instrument": "BTC-USDT-SWAP", "direction": "short", "pnl": -0.06}
  ],
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

上述物件放在既有 `notes` 陣列內。所有表格數值只能是有限數字或 `null`；`null` 一律顯示「未知」。模型 map 最多 50 個名稱，各名稱為 1–80 字的純文字，不能含疑似私密資料；模型支出與合計為非負 USD 金額。空模型 map 或某日缺少模型明細，不會推成零；合計也直接顯示填報的 `api_cost_total`，不以缺漏的模型明細自行補算。成交最多 100 筆，每筆都要有標的、`long`／`short` 與有限損益。

交易損益、手續費、資金費與淨損益以 **USDT** 填報；API 花費以 **USD** 填報。頁面註明「API 花費為交易員依 token 用量自記估算」。淨損益採交易員提供的 `net_after_costs`（含所有成本及 API 花費），前端不將 USD 當成 USDT 扣除、不自動換匯，也不由權益或各欄位重算。未實現損益是填報時點值，不逐日相加來推估累計。每天的資料由交易員填報；本功能不產生估造結算、不新增採集或排程。

## 參考文獻

GitHub。（無日期-a）。[Billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-d）。[Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-e）。[Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。GitHub Docs。2026 年 10 月 30 日檢索。

OKX。（無日期）。[OKX API documentation](https://www.okx.com/docs-v5/en/)。2026 年 10 月 30 日檢索。

wuyulun0823-lab。（無日期）。[race](https://github.com/wuyulun0823-lab/race)［原始碼儲存庫］。GitHub。

## AI 額度（ai_quota.json）

桌機每 5 分鐘發布 `ai_quota.json`（時間為 epoch 秒），工作流程以選用檔打包，內容不是有效 JSON 時略過並警告，不使部署失敗。頁面頂端是固定高度（56px、兩行）的額度區塊，全部以 `textContent` 顯示：第一行為狀態（紅：high 警示、資料暫無、超過 3 小時未更新；琥珀：medium 警示；中性：AI 額度正常），第二行為額度明細。點一下可展開全部警示（浮層，不推擠版面）。與 `data.json` 一樣每 30 秒以 `no-store` 加 `?v=` 重新讀取，並透過 `RaceStable` 更新。本檔不得由頁面維護工單修改。
