# 交易儀表板管理交接

指定接手角色：Grok「交易儀表板專家」。本文件是交接清單；待填的部署與交接結果不表示已完成。

[網站](https://fadinggo.github.io/race/) · [儲存庫](https://github.com/Fadinggo/race) · [更新 workflow](https://github.com/Fadinggo/race/actions/workflows/update-dashboard.yml) · [部署及恢復說明](README.md)

## 固定架構與邊界

- 正式執行在 GitHub 託管 Actions，cron `2-57/5 * * * *`（UTC，約五分鐘，可能延遲）。Pages source 是 GitHub Actions，同次 workflow 直接部署；個人電腦不需開機。
- 採集器只讀資料，不負責機器人持續交易。交易服務另外管理。
- A/B 為 `Grok-Trader-A`、`Grok-Trader-B`，起始本金未確認保持 null，不把計畫的 10 USDT 當已入金。
- 七個 secrets 僅記名稱：`OKX_A_API_KEY`、`OKX_A_SECRET_KEY`、`OKX_A_PASSPHRASE`、`OKX_B_API_KEY`、`OKX_B_SECRET_KEY`、`OKX_B_PASSPHRASE`、`DASHBOARD_STATE_KEY`。B 在 workflow 已映射到既有 `OKX_API_KEY`、`OKX_SECRET_KEY`、`OKX_PASSPHRASE`。
- Checkpoint 以獨立金鑰 HMAC 驗證，**不是加密**。公開儲存庫只有已允許公開觀測及不可逆識別代碼，不加入原始 UID、訂單／成交 ID 或秘密。
- data/history/checkpoint 必須同 snapshot_id、同 commit。Pages artifact 只有 index.html、dashboard.js、data.json、history.json、.nojekyll，不含 checkpoint。
- 日常 Run workflow 保持 bootstrap false。只有完整待連線配對可首次 bootstrap。驗簽失敗或缺檔不能刪除重設，需原金鑰與可信 commit 的同批次三檔恢復；換金鑰或帳戶須另定遷移方案。
- Codex 部署完成後不保留持續監控或排程。run_sync.py 只是手動備援，不得未協調就與 Actions 同時推送。

## 初始驗收紀錄

只填實際觀測證據，不填秘密、原始 UID 或 API 回應全文。

| 項目 | 結果與證據 |
|---|---|
| 已部署程式 commit SHA | 待填 |
| 七個 repository secrets 名稱存在（只核對存在） | 待填 |
| Pages source = GitHub Actions | 待填 |
| Grok「交易儀表板專家」已收到交接且可管理的證據 | 待填 |
| 首次 bootstrap run URL、事件與時間 | 待填 |
| A 狀態、最後成功時間、確認的權益 | 待填 |
| B 狀態、最後成功時間、確認的權益 | 待填 |
| 首次三檔相同 snapshot_id | 待填 |
| 後續 schedule run URL 與時間 | 待填 |
| 後續 snapshot_id、各帳戶成功時間已前進 | 待填 |
| 歷史觀測延續，未於每次工作歸零 | 待填 |
| 線上網站可見資料符合該批 JSON | 待填 |
| Pages artifact 僅允許的五檔 | 待填 |
| GitHub Linux 執行器測試結果 | 待填 |
| 個人電腦關機後實際更新測試（若有執行） | 待填；架構不依賴個人電腦，不冒稱已關機實測 |

## 日常處理順序

1. 看 A/B 各自最後成功時間與錯誤，再看 Actions 最近 schedule 或 workflow_dispatch 結果。
2. 區分 OKX 讀取、checkpoint、Git 推送、Pages 部署及排程延遲，依 README 排查。工作綠色仍須確認帳戶不是 error。
3. 必要時手動補更新，bootstrap false；修復後驗證線上新批次、成功時間前進及歷史延續。
4. 涉及帳戶變更、狀態金鑰輪替、歷史重設或交易本身，另行確認授權與恢復方案。
5. 維護紀錄只留時間、run URL、commit、固定錯誤碼、處理動作與驗收結果，不寫秘密或原始帳戶識別。