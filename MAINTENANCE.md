# 雲端維護派工

本文件定義 Grok「交易儀表板專家」與 ChatGPT Work「race 雲端維護」的維護協定。**雲端瀏覽器登入、雙向握手、第一輪實作與主管事件驗收已通過；Work 正式託管派工事件仍在接通中。**不能把人工啟動的第一輪當成已啟用自動派工。

實測記錄（2026-10-30）：[Issue #1](https://github.com/Fadinggo/race/issues/1) 與 [PR #2](https://github.com/Fadinggo/race/pull/2) 的舊 GitHub bot 路徑收到[環境需求回覆](https://github.com/Fadinggo/race/pull/2#issuecomment-6508939343)，主管曾留下 [blocked 回條](https://github.com/Fadinggo/race/pull/2#issuecomment-6509634422)。使用者隨後授權改走 Work 雲端瀏覽器；新雲端對話於 07:02（台灣時間）實際向專家送訊，讀回 `RACE_CLOUD_BROWSER_READY`。專家已恢復原有 PR #2 事件驗收例程，新的實作必須按新 head 重新核對，不沿用舊環境阻塞。沒有啟用獨立付費 API 維護器。

第一輪 Work 實作 head：`40a2588850ab4f994336923a612185ab5fe96dda`；[實作回報](https://github.com/Fadinggo/race/pull/2#issuecomment-6510694465)與[主管 accepted 回條](https://github.com/Fadinggo/race/pull/2#issuecomment-6510762303)已讀回。主管回條確認由 PR 留言事件例程喚醒。PR 實際仍為 open、未合併：後續關閉操作被平台 Auto-review 以缺少明確關閉授權拒絕，未改走其他方法。accepted 回條中「PR 關閉」的文字不是實際狀態證據。

## 分工與流程

主管負責辨識問題、訂定允許修改範圍與驗收標準；Work 雲端工作負責實作、測試及回報；主管核對結果後決定接受或退回。正式網站的唯讀資料採集仍由既有 GitHub Actions 處理，資料更新備援見 [CLOUD-REFRESH.md](CLOUD-REFRESH.md)。

1. 主管使用已連接的 GitHub 帳戶在 `Fadinggo/race` 建立 Issue，加入 `codex-maintenance` 標籤，並放入下列唯一一段工單 JSON。
2. `maintenance-dispatch.yml` 驗證儲存庫、作者、觸發者與工單格式，從最新 `main` 建立 `codex/maintenance-N`，只新增不可變更的工單檔案，並在 Issue 留下準備完成回條與初始 commit。
3. 主管在建立 Issue 的當次工作中有界等候完成回條；若準備仍排隊，安排一次性延後檢查，不假設 Issue 留言會喚醒主管。讀取回條後，使用現有 GitHub 連接器建立該分支到 `main` 的 PR。準備流程不以 `GITHUB_TOKEN` 建立 PR，以免形成需要人工批准才執行的檢查。（GitHub，無日期）
4. 主管先建立範圍限定該 PR 的 Grok 原生事件驗收例程，再由自己的既有 GitHub 連線在 PR 留下 `RACE_DISPATCH_V1 issue=N`，附原始工單與明確實作要求。實作入口改為既有 Work 雲端對話的 GitHub PR 事件任務；不得再呼叫舊 GitHub bot。Work 任務尚未啟用或未驗證時，必須明示待接通，不能把人工送訊當成自動派工。Work 支援 GitHub PR 活動事件與既有雲端對話，但本帳戶的實際事件接收仍須另行驗收。（OpenAI，無日期）
5. Codex 在 PR 分支實作並提交 `RACE_IMPLEMENTATION_V1` 回報。`maintenance-checks.yml` 的 `pull_request_target` 工作只執行正式基底分支的可信範圍檢查，讀取 PR Git 內容，不執行 PR 程式；另一個 `pull_request` 工作才執行離線 Python／Node 測試。兩者都只有 contents 讀取權限，沒有 OKX 憑證。
6. 主管接到事件後核對回報 commit、當前 PR head、全部變更檔案、工作流程未被變更／刪除、來自 `pull_request_target` 的可信範圍檢查、同一 head 的回歸測試及原始驗收條件，不能只依賴綠色狀態。合格才接受；不合格在同一 PR 給出具體修正要求。驗收完畢後停用該 PR 的例行程序，避免重複喚醒。

## 工單格式

Issue 可包含說明文字，但只能有一個 `RACE_WORK_ORDER_V1` fenced block。不得包含秘密或原始帳戶資料。

````text
```RACE_WORK_ORDER_V1
{
  "version": 1,
  "kind": "smoke",
  "objective": "驗證主管派工、Codex 雲端執行與主管收件驗收；只新增驗收結果文件。",
  "allowed_paths": [".maintenance/results/{issue_number}.md"],
  "acceptance": [
    "只新增指定結果文件，記錄已讀工單與實際檢查結果",
    "在 PR 回報實作 commit 與證據，不改網站及交易資料",
    "主管能由 PR 事件收到回報並寫入驗收結果"
  ]
}
```
````

`N` 是 GitHub Issue 號碼。`smoke` 僅允許指定結果文件。`maintenance` 允許明確列出的 `index.html`、`dashboard.js`、`README.md`、`HANDOFF.md` 或符合程式白名單的一般測試檔；不支援萬用字元。派工、安全檢查測試與工作流程不在自動修改範圍。

## 去重與回報

- 同一 Issue 固定對應同一分支與原始工單摘要。已建立後不得修改範圍再重派；需求改變時另開 Issue，保留舊紀錄。
- 主管建立 PR 前先搜尋同一 head/base 是否已有 PR。已有則沿用，不重建。
- 已核實官方 bot 的環境、額度或權限錯誤也需處理，即使沒有實作回報或新 head；以原因類別加 head 去重，記錄 blocked 後暫停，不自動重派。
- 每次只在新的實作回報或新的 head/CI 結果出現時驗收，記錄 `RACE_ACCEPTANCE_V1 issue=N head=完整SHA result=accepted|changes_requested|blocked`。
- 忽略主管自己的留言及已處理過的 head/event，不因自己的回覆再次派工。沒有新回報或可採取行動的變更時保持安靜。
- Codex 回報需有 `RACE_IMPLEMENTATION_V1`、完整 head SHA、修改檔案、執行指令、通過／失敗／略過結果與逐項驗收證據。
- `pull_request_target` 執行紀錄本身的 SHA 代表正式基底，不能當成 PR head。主管須核對該執行確實關聯此 PR，並以可信 guard 輸出的 `head_sha` 與當前 PR head 比對；回歸測試則核對它實際 checkout 的 PR head。過期的綠燈不可代替當前版本驗收。
- 初始連線測試不自動合併或關閉；完成驗收後保留 Issue 與 PR 作證據。平台審核拒絕的動作不得改用其他方法執行。

## 邊界與故障處理

自動派工不存取 OKX Secrets，不交易、不調整交易服務、不更換帳戶、不重設歷史，也不修改自身派工權限或工作流程。需要上述變更時回報明確阻塞，交由另行審查的工作處理。

這條路徑使用 Work 雲端工作與已登入的雲端瀏覽器，不會喚醒使用者電腦上的某個既有聊天。GitHub 與 Grok 的雲端事件、帳戶連線及可用額度皆需正常。登入過期時只使用官方安全登入交接，不把密碼或 cookie 傳進聊天。沒有事件到達、排隊延遲、額度不足或連線失效時，不得聲稱維護已完成。

派工失敗可查看該 Issue 的 Actions 執行；修正可恢復的服務問題後，以手動 workflow dispatch 指定同一 Issue 重試。不得 force-push、覆蓋既有工單或偽造準備回條。若分支／摘要不一致，先保留證據並回報主管。

範圍檢查使用公開 GitHub API 取得準備回條；遇到限流或服務錯誤會拒絕通過，需稍後重跑。可信範圍檢查的工作流程由 `pull_request_target` 取正式基底版本，避免 PR 移除自己的檢查；該工作不執行 PR 測試。本方案未建立 branch rules，具有儲存庫寫入權限的帳號仍可直接操作主分支；因此檢查程式不是完整的權限隔離，主管仍需審查完整變更及其行為，尤其測試檔也是可執行程式。

GitHub 更新流程部署的是 `main`，因此一般修正經主管接受並合併後，仍需觀察下一次正式更新與 Pages 發布結果，才能稱為網站修復完成。

## 參考文獻

OpenAI. (無日期). *Scheduled tasks*. https://learn.chatgpt.com/docs/automations

OpenAI. (無日期). *Using cloud browser in ChatGPT*. https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt

GitHub. (無日期). *GITHUB_TOKEN*. https://docs.github.com/en/actions/concepts/security/github_token
