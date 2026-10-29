# 交易儀表板管理交接

指定接手角色：Grok「交易儀表板專家」。本文件是交接清單；待填的部署與交接結果不表示已完成。

[網站](https://fadinggo.github.io/race/) · [儲存庫](https://github.com/Fadinggo/race) · [更新 workflow](https://github.com/Fadinggo/race/actions/workflows/update-dashboard.yml) · [部署及恢復說明](README.md)

## 固定架構與邊界

- 正式執行在 GitHub 託管 Actions，cron `3,8,13,18,23,28,33,38,43,48,53,58 * * * *`（UTC，約五分鐘，可能延遲）。Pages source 是 GitHub Actions，同次 workflow 直接部署；個人電腦不需開機。
- 採集器只讀資料，不負責機器人持續交易。交易服務另外管理。
- A/B 為 `Grok-Trader-A`、`Grok-Trader-B`，起始本金未確認保持 null，不把計畫的 10 USDT 當已入金。
- 七個 secrets 僅記名稱：`OKX_A_API_KEY`、`OKX_A_SECRET_KEY`、`OKX_A_PASSPHRASE`、`OKX_B_API_KEY`、`OKX_B_SECRET_KEY`、`OKX_B_PASSPHRASE`、`DASHBOARD_STATE_KEY`。B 在 workflow 已映射到既有 `OKX_API_KEY`、`OKX_SECRET_KEY`、`OKX_PASSPHRASE`。
- Checkpoint 以獨立金鑰 HMAC 驗證，**不是加密**。公開儲存庫只有已允許公開觀測及不可逆識別代碼，不加入原始 UID、訂單／成交 ID 或秘密。
- data/history/checkpoint 必須同 snapshot_id、同 commit。Pages 打包白名單是 index.html、dashboard.js、data.json、history.json、.nojekyll；首次實際 artifact 省略空白 .nojekyll，只有四個網站檔案，不含 checkpoint。
- 日常 Run workflow 保持 bootstrap false。只有完整待連線配對可首次 bootstrap。驗簽失敗或缺檔不能刪除重設，需原金鑰與可信 commit 的同批次三檔恢復；換金鑰或帳戶須另定遷移方案。
- Codex 不保留本機持續監控或排程；使用者已指定專家監督、Codex 實作維護，雲端派工的實際啟用狀態見 `MAINTENANCE.md`。run_sync.py 只是手動備援，不得未協調就與 Actions 同時推送。

## 初始驗收紀錄

只填實際觀測證據，不填秘密、原始 UID 或 API 回應全文。

| 項目 | 結果與證據 |
|---|---|
| 已部署程式 commit SHA | `48ea6a865d5cf0e69b104f2b5f32d41e429b582d`；網頁上傳 24 檔，與已測 `39d28935` 文字內容相同，17 檔僅換行為 CRLF |
| 七個 repository secrets 名稱存在（只核對存在） | 已在 GitHub Settings 確認七項名稱；一次性設定 PAT 已撤銷 |
| Pages source = GitHub Actions | 已儲存並核對；collect/deploy 由 GitHub 託管 Ubuntu 執行器完成 |
| Grok「交易儀表板專家」已收到交接且可管理的證據 | 台灣 2026-10-30 04:42 前已明確回覆「從現在起 Fadinggo/race 的日常管理由我負責」，完成 workflow/runs 核對；可讀取狀態與日誌、分析及測試，寫入權限限制見下方 |
| 首次 bootstrap run URL、事件與時間 | [40948056723](https://github.com/Fadinggo/race/actions/runs/40948056723)，workflow_dispatch；台灣 2026-10-30 04:19:55 啟動、04:20:23 成功 |
| A 狀態、最後成功時間、確認的權益 | 首次採集 ok，台灣 04:20:02，0.0 USDT、無持倉及近期成交 |
| B 狀態、最後成功時間、確認的權益 | 首次採集 ok，台灣 04:20:02，0.0 USDT、無持倉及近期成交 |
| 首次三檔相同 snapshot_id | `28ea8f7e62314b238234084c26f8f259`；資料 commit `2c24cb947ec9ce0675398a7b2df3baa785278cba` |
| 後續 schedule run URL 與時間 | 尚未驗收；截至台灣 2026-10-30 04:49:46 仍為 0 個 schedule run，workflow active。未以兩次 manual 成功替代自動觸發驗收 |
| 後續 snapshot_id、各帳戶成功時間已前進 | 手動續跑已前進至 04:29:09；schedule 的後續批次仍待確認 |
| 歷史觀測延續，未於每次工作歸零 | 第二次手動執行 [40949423609](https://github.com/Fadinggo/race/actions/runs/40949423609) 成功，bootstrap false；04:29:09 新批次 `0fca3d34887a47acbf23fd447ce5ddd9`，A/B 各 2 點，首筆 04:20:02 完整保留 |
| 線上網站可見資料符合該批 JSON | 已由公開 HTTPS JSON 與瀏覽器畫面交叉確認 A/B 數值、狀態、時間一致 |
| Pages artifact 內容驗證 | 實際下載檢查只有 index.html、dashboard.js、data.json、history.json 四檔；`.nojekyll` 未進入最終 artifact，直接 Pages 部署成功；不含 checkpoint 或私有檔 |
| GitHub Linux 執行器測試結果 | GitHub Ubuntu job 執行 67 tests，OK（3 個可選加密測試 skipped）；Grok Linux 安裝 PyNaCl 後全 67 與前端 11 通過 |
| 個人電腦關機後實際更新測試（若有執行） | 未實際關閉使用者電腦；已核對兩個 job 的 runner 為 GitHub Actions、ubuntu-24.04，更新程序不在本機 |

## 日常處理順序

1. 看 A/B 各自最後成功時間與錯誤，再看 Actions 最近 schedule 或 workflow_dispatch 結果。
2. 區分 OKX 讀取、checkpoint、Git 推送、Pages 部署及排程延遲，依 README 排查。工作綠色仍須確認帳戶不是 error。
3. 必要時手動補更新，bootstrap false；修復後驗證線上新批次、成功時間前進及歷史延續。
4. 涉及帳戶變更、狀態金鑰輪替、歷史重設或交易本身，另行確認授權與恢復方案。
5. 維護紀錄只留時間、run URL、commit、固定錯誤碼、處理動作與驗收結果，不寫秘密或原始帳戶識別。
## 存取與維護現況

- 一次性 Secrets 設定 PAT 已於 GitHub 移除；正常排程只用 GitHub 自帶 GITHUB_TOKEN。Grok 安全環境仍保留已撤銷的 RACE_GITHUB_SETUP_TOKEN 值，接手者沒有刪除該環境欄位的工具；它已失效，未再次讀取其值。
- 狀態金鑰備份留在 Grok 雲端 `/workspace/race-sync/private/github-state.key`（目錄 0700、檔案 0600），不可貼出內容或任意更換。
- Grok 連接器可讀 workflow、jobs、logs 及 repository 內容，但未提供寫檔或設定 Secrets 工具；雲端 SSH 連線受限。這次以已登入的 GitHub 網頁完成程式提交，沒有繞過網路限制。未來需改程式時由接手者使用可用的 GitHub 網頁或經授權的 HTTPS 流程。
- 首次 artifact ZIP 的 SHA256 為 `258a1af174597c11ee2d004f2231c49186bb7bb8f482a8c49e58d362e678ffee`，與 Actions UI digest 一致。

## 接手者的一次性後續驗收

- Grok「交易儀表板專家」已實際建立原生雲端例行程序「race 首次自動排程唯讀驗收（2026-10-30 05:30）」。在右側網頁打開例行程序，已核對觸發器為 Once October 30 at 5:30 AM，指示限定唯讀驗收與結果回報。
- 此次檢查要求真正 event=schedule 成功、網站同批新資料、A/B 各自 ok 與歷史延續；不能用手動執行代替。
- 結果回報專家聊天及「交易競賽群」，回報後刪除該一次性例行程序。這是接手者的驗收通知，不是第二套採集或推送程序；沒有建立 Codex 後續監控。
- 後續驗收尚未發生，不能把已排定的檢查當作已通過。

## 排程觸發修復紀錄（2026-10-30）

05:30 的一次性唯讀驗收實際執行，專家於 05:31 回報尚無 event=schedule，只有兩次成功 manual run，並已刪除一次性例行程序。因此自動更新仍未驗收。05:34 再次公開 API 核對同樣為 0 個 schedule run、workflow active、main 設定存在。

目前僅將 cron 分鐘改為 3、8、13……58，維持每五分鐘一次，讓 GitHub 重新處理排程與 actor 關聯。這是修復嘗試，必須觀察真實 schedule run、成功部署及網站時間前進後才能判定有效；不以手動執行代替。未修改 Secrets、bootstrap、帳戶、採集或歷史。
