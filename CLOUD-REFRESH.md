# 雲端資料更新備援

此文件記錄 GitHub 原生 cron 尚未觸發時的替代路徑。**目前正在部署驗收；程式與設定存在不代表已通過自動更新驗收。**

## 流程

Grok「交易儀表板專家」的原生雲端例行程序每小時更新一次固定的 [Issue #3](https://github.com/Fadinggo/race/issues/3)。GitHub 收到這次編輯後啟動有時間上限的 relay，在約 55 分鐘內、每五分鐘呼叫一次既有的 `update-dashboard.yml`，共最多 12 次。採集、狀態驗證及 Pages 發布沿用既有正式程式。

這不是讓 GitHub cron 恢復，也不是本機排程。Grok 只負責每小時的一次喚醒，GitHub 的程式負責該小時內計時。沒有建立新 PAT、付費 API 維護器或外部主機；Grok 執行仍會使用既有方案額度。

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

Relay 不是無限迴圈，不會啟動自己，不會在網路失敗後盲目重試 POST。錯過的時間槽不會集中補跑。原生 Grok 例程停止、額度耗盡或連線失效時，不再有下一小時的喚醒；網站保留最後資料，超過 15 分鐘顯示過期，不能把舊數字當成即時餘額。

排查順序：Issue #3 的時間是否前進 → `Cloud dashboard refresh relay` 的驗證與觸發記錄 → `Update trading dashboard` 的 collect/deploy → 網站資料時間、兩個帳戶狀態及歷史批次。不得以單一綠色工作取代網站驗收。

## 停用與切回

先在 Grok 暫停專用的每小時例程，再停止尚未結束的 relay。不要停用交易機器人的其他例程。只有 GitHub 原生 `schedule` 重新取得實際成功證據後，才切回原生 cron；避免同時保留兩套定時喚醒。

驗收結果與工作連結由部署者補入 `HANDOFF.md`。

