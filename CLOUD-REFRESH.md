# 雲端資料更新與驗收

此文件記錄取代未成功觸發之 GitHub 原生 cron 的正式路徑。**2026-10-30 已驗證 Work 原生自動喚醒，以及同一輪兩次成功採集與 Pages 發布；整輪 12 次、後續每小時持續執行及實際關機測試仍未完成。**

## 流程

ChatGPT Work 網頁版的原生雲端任務「race 每小時資料喚醒」每小時更新一次固定的 [Issue #3](https://github.com/Fadinggo/race/issues/3)。GitHub 收到這次編輯後啟動有時間上限的 relay，在約 55 分鐘內、每五分鐘呼叫一次既有的 `update-dashboard.yml`，共最多 12 次。採集、狀態驗證及 Pages 發布沿用既有正式程式。

這不是讓 GitHub cron 恢復，也不是本機排程。Work 只負責每小時的一次喚醒，GitHub 的程式負責該小時內計時。沒有建立新 PAT、付費 API 維護器或外部主機；Work 執行使用既有方案額度。Grok 同用途例程建立時發生審查服務錯誤，沒有儲存成功，已停止重試，避免兩套喚醒並行。

[雲端任務設定](https://chatgpt.com/scheduled?automationId=6ae3d47305848190bd4bbde68ad3b268&automationSource=cloud)已於 2026-10-30 建立並啟用；任務 ID 為 `6ae3d47305848190bd4bbde68ad3b268`，Asia/Taipei 每小時第 25 分鐘執行。07:25 場次已實際更新 Issue #3 並觸發下列工作。`update-dashboard.yml` 的舊 `schedule` 區塊已移除，保留手動及 relay 使用的 `workflow_dispatch`，採集與部署設定維持原狀。

## 首輪原生自動觸發證據

以下時間均為 2026-10-30 台灣時間；這是 Work 原生任務產生的 Issue 事件，不是用手動 relay 測試代替自動驗收。

| 階段 | 實際證據 |
|---|---|
| Work 自動喚醒 | 每小時 25 分任務的 07:25 場次自動編輯 [Issue #3](https://github.com/Fadinggo/race/issues/3) |
| GitHub relay | [40973201815](https://github.com/Fadinggo/race/actions/runs/40973201815)，事件為 `issues` |
| 第一個子工作 | [40973213052](https://github.com/Fadinggo/race/actions/runs/40973213052)，07:26:58 啟動，collect/deploy 均 success |
| 第一批公開資料 | 更新 07:27:06.878；snapshot `5635a251524940ac9915f9ab70846dc0`；A/B 均 ok，歷史各 7 點 |
| 第二個子工作 | [40973774300](https://github.com/Fadinggo/race/actions/runs/40973774300)，07:31:58 啟動，比第一個晚 300 秒，collect/deploy 均 success |
| 第二批公開資料 | data/history 同為 snapshot `bef46c472edc4bebbdaba41fe7b321f9`，更新 07:32:06.145；A/B 均 ok，歷史各 8 點 |

已驗證的工作在雲端執行，資料更新不需要本機程序；**沒有為驗收而實際關閉使用者電腦**，也尚未將首輪兩次成功擴張為長期可用性或準時更新保證。每輪內維持五分鐘間隔，但跨輪啟動延遲可能使交界間隔不同。

## 固定控制資料

- 儲存庫：`Fadinggo/race`，分支：`main`。
- Issue：`3`，標題：`Dashboard cloud refresh heartbeat`。
- 發送者與 Issue 作者必須是 `Fadinggo`，GitHub 使用者 ID 必須是 `257707061`。
- Body 必須完整替換成兩行，第二行使用當次實際 UTC 時間：

```text
RACE_DASHBOARD_TICK_V1
2026-10-30T00:00:00Z
```

上述時間只是格式範例，不可照抄。時間必須前進，過期事件與不符格式的編輯會被拒絕。不要加入交易內容、金鑰或其他指令，不要新增留言。

## 權限與失敗處理

Relay 只使用 GitHub 提供給該次工作的短期 `GITHUB_TOKEN`，取得本專案的 Actions 寫入權限，呼叫固定的正式更新工作流程。它不讀取 OKX Secrets，也不修改資料。所有正式更新都使用 `bootstrap: false`。

Relay 不是無限迴圈，不會啟動自己，不會在網路失敗後盲目重試 POST。錯過的時間槽不會集中補跑。Relay 綠燈仍可能伴隨 `dispatched: 0`；應檢查實際派送數與子工作結果。Work 雲端任務停止、額度耗盡或連線失效時，不再有下一小時的喚醒；網站保留最後資料，超過 15 分鐘顯示過期，不能把舊數字當成即時餘額。

排查順序：Issue #3 的時間是否前進 → `Cloud dashboard refresh relay` 的驗證與觸發記錄 → `Update trading dashboard` 的 collect/deploy → 網站資料時間、兩個帳戶狀態及歷史批次。不得以單一綠色工作取代網站驗收。

## 停用與切回

先在 ChatGPT 網頁版「已排程」暫停專用的每小時任務，再停止尚未結束的 relay。不要停用交易機器人的其他例程。目前正式 workflow 沒有 `schedule` 區塊。未來若要切回原生 cron，須另行修改與驗證真實 `schedule` 事件、採集及網站新批次，再協調切換；不得把這次 Work／Issue 路徑成功當成 cron 已修復，或讓兩套喚醒未經協調並行。

驗收結果與工作連結同步記錄於 `HANDOFF.md`；後續紀錄應追加實際觀測，不覆蓋原有失敗與恢復歷程。

