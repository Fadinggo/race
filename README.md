# TRADING ARENA：Grok 帳戶儀表板

[網站](https://fadinggo.github.io/race/) · [儲存庫](https://github.com/Fadinggo/race) · [更新工作流程](https://github.com/Fadinggo/race/actions/workflows/update-dashboard.yml) · [管理交接清單](HANDOFF.md)

正式部署由 **GitHub Actions 的 GitHub 託管執行器**讀取 `Grok-Trader-A`、`Grok-Trader-B` 的 OKX 資料，再直接部署 GitHub Pages。工作在 GitHub 提供的環境執行，**個人電腦關機不會中止更新流程**，不需要本機常駐 Python、SSH 私鑰或 Codex 排程。（GitHub，無日期-c）

這是唯讀儀表板，不下單、撤單、改槓桿或轉移資金，**也不負責讓交易機器人本身持續交易**。交易程序的執行環境、策略與存活狀態由各自服務維持。

介面沿用 [wuyulun0823-lab/race](https://github.com/wuyulun0823-lab/race) 的設計；本專案重新建立帳戶資料、身分綁定與歷史觀測，不沿用原作者績效。（wuyulun0823-lab，無日期）實際部署及驗收結果記在交接清單；程式存在不代表已完成上線驗收。

## 正式更新流程

```text
GitHub 排程或手動啟動 → checkout main、測試
→ 驗證 checkpoint、唯讀查詢兩個 OKX 帳戶
→ 同一 commit 保存 data.json、history.json、state-checkpoint.json
→ 只打包允許公開的網站檔案 → 同一次 workflow 直接部署 Pages
```

工作流程是 `.github/workflows/update-dashboard.yml`，cron 為 `2-57/5 * * * *`：UTC 每小時第 2、7、12……57 分鐘，約每五分鐘；台灣時間的分鐘數相同。GitHub 排程可能延遲，壅塞時也可能略過工作，**不是每五分鐘準時更新的 SLA**。排程使用預設分支，本專案固定 `main`；公開儲存庫長時間沒有活動也可能停用排程。（GitHub，無日期-b）

網頁每 30 秒檢查新 JSON，採集、部署及 CDN 更新會增加延遲。每張卡片保留自己的最後成功時間，超過 15 分鐘顯示過期。單一帳戶失敗時保留最後成功值並顯示錯誤，首次未知值保持 `null`。工作流程以 concurrency 排序，不取消正在發布的工作。

公開儲存庫使用標準 GitHub 託管執行器，其運算使用免費。本方案採標準 `ubuntu-24.04`，不要求額外常駐主機或大型執行器。GitHub Pro 不提供精準排程保證；其他儲存、限制及實際費用仍以帳戶 Billing 頁面為準。（GitHub，無日期-a）

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

`config.example.json` 是正式非秘密設定，包含 bot 名稱、環境變數名稱、`start: null`、`simulated: false` 及資料上限。不要填入憑證值或原始 UID。採集器只允許固定 `https://www.okx.com` 的唯讀 GET 端點：account/config、account/balance、account/positions、trade/fills，不允許重新導向或交易請求。OKX API key 應使用符合唯讀用途的權限。（OKX，無日期）

在 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。正式流程直接部署同次工作的 Pages artifact，不使用「Deploy from a branch」，也不依賴 `GITHUB_TOKEN` 推送後再觸發另一個 push 工作流程。採集需要 `contents: write`；部署需要 `pages: write`、`id-token: write` 及 `github-pages` environment。確認該 environment 允許 `main` 部署，審核設定符合自動發布需求。（GitHub，無日期-e）正式執行使用工作流程提供的 `GITHUB_TOKEN`，不依賴個人電腦登入或 SSH 私鑰。

## 首次連線與手動更新

1. 確認正式程式已在 `main`、七個 Secrets 齊全、Pages source 正確，`data.json` 與 `history.json` 是完整、同批 `awaiting-live-connection` 待連線資料：正確 bot 名稱、未知數值為 null、歷史和成交為空。
2. 到 **Actions → Update trading dashboard → Run workflow**，選 `main`。只有第一次建立新 checkpoint，才把 `bootstrap` 設為 `true`，再按 Run workflow。（GitHub，無日期-d）
3. 查看 `collect`、`deploy` 結果。採集成功發布「帳戶讀取失敗」狀態也可能是綠色工作，因此還要確認 A/B 各自狀態、最後成功時間與實際資料。
4. 對照三個資料檔相同的 `snapshot_id` 及線上網站；再等待一次 **schedule** 事件完成，確認新批次、時間前進、歷史延續。將實際 run URL、commit 及結果填入 `HANDOFF.md`。

日後手動補更新時，使用同一 GUI 流程，**保持 `bootstrap: false`**。正常排程不會 bootstrap。勾選 bootstrap 不會授權重設現有身分或歷史；缺檔、混合批次、殘留已啟用資料或原作者檔案都不能作為首次連線來源。

## 資料意義

- 卡片是 **USDT 權益**（USDT `details.eq`），不把 USD `totalEq` 或其他幣別直接當 USDT。成功確認為零才顯示 `0.00 USDT`；未知或首次讀取失敗保持 null。（OKX，無日期）
- `start: null` 表示本金未確認，ROI 不臆測。計畫投入的 10 USDT 不是已確認本金。日後設定本金後，簡單報酬率是 `(equity / start - 1) × 100%`；有入金或出金時，不可當作已排除資金流的純交易績效。
- 成交取近期三天，分頁並去重。達分頁上限時標示不完整、筆數使用 `≥`；未知全期 `fees_total`、`funding_total`、`fills_total` 保持 null。費用正負、損益幣別、合約張數保留，缺幣別則明示未知。（OKX，無日期）
- 歷史只記錄本採集器成功觀測值，目前每帳戶最多 50,000 點，不回填原作者曲線或推測未觀測時段。
- A/B 必須不同帳戶，每次檢查與既有身分一致。更換帳戶不能直接接上舊曲線；同帳戶的 API 憑證輪替則可保留綁定。

## 狀態持久化與恢復

GitHub 託管執行器每次工作使用新的環境，`scripts/gha_snapshot.py` 會驗證儲存庫的 `state-checkpoint.json`，恢復歷史、身分與去重狀態；執行器暫存只放 `RUNNER_TEMP`。（GitHub，無日期-c）新 checkpoint 與 data/history 同 `snapshot_id`，由發布工具放入同一 commit。

**Checkpoint 是 HMAC 驗證，不是加密。**公開儲存庫裡的內容可被任何人閱讀，只有已允許公開的觀測值及獨立秘密金鑰產生的不可逆識別代碼。帳戶、成交及驗簽各有不同用途標記；不保存原始 UID、order ID、trade ID、bill ID 或憑證。HMAC 驗證完整性，不隱藏已公開觀測。

Pages artifact 只有 `index.html`、`dashboard.js`、`data.json`、`history.json`、`.nojekyll` 五個檔案；**不包含 checkpoint**、設定檔、腳本、Git 中繼資料或私有暫存。Checkpoint 雖不在 Pages，仍存在公開儲存庫。

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
| 長時間沒 schedule 工作 | 查 workflow 是否停用、預設分支及排程延遲；可手動補跑，bootstrap false |

## 管理分工與備援

長期管理交給 Grok **「交易儀表板專家」**依 `HANDOFF.md` 接手，是否完成以清單證據為準。GitHub Actions 定時執行，不需每五分鐘呼叫 AI；Codex 完成部署後不建立或保留持續排程。交易策略與交易服務另行管理。

舊 `scripts/run_sync.py` 僅保留作**手動備援**，需要自行維持主機、私有狀態與 SSH 設定，不是正式部署，不能保障個人電腦關機後更新。它與 Actions checkpoint 不是可自動互換的狀態格式，未另行規畫恢復與協調前，不得與正式 workflow 同時推送。

不連線帳戶的驗證指令：

```powershell
python -B -m unittest discover -s tests -p 'test_*.py'
node --test tests/dashboard.test.js
```

模擬測試涵蓋身分綁定、錯誤保留、零與未知、分頁與單位、簽章恢復、秘密與原始 ID 排除、跨程序鎖、公開檔白名單及批次一致性；不能代替真實帳戶與網站驗收。

## 參考文獻

GitHub。（無日期-a）。[Billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-b）。[Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-c）。[GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-d）。[Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-e）。[Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。GitHub Docs。2026 年 10 月 30 日檢索。

GitHub。（無日期-f）。[Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。GitHub Docs。2026 年 10 月 30 日檢索。

OKX。（無日期）。[OKX API documentation](https://www.okx.com/docs-v5/en/)。2026 年 10 月 30 日檢索。

wuyulun0823-lab。（無日期）。[race](https://github.com/wuyulun0823-lab/race)［原始碼儲存庫］。GitHub。