# 雲端維護派工

本文件定義 Grok「交易儀表板專家」與 Codex 的維護協定。**派工與檢查程式已部署，但端到端測試因 Codex 雲端環境阻塞而未通過。**不能視為已啟用自動維護。

實測記錄（2026-10-30）：主管建立 [Issue #1](https://github.com/Fadinggo/race/issues/1)，Actions 建立工單分支，主管建立 [PR #2](https://github.com/Fadinggo/race/pull/2)，並收到官方 bot 的[環境需求回覆](https://github.com/Fadinggo/race/pull/2#issuecomment-6508939343)。新 Cloud 環境雖已發布，GitHub 實作入口仍要求 Legacy 環境；帳戶的官方 Legacy 設定頁目前導回首頁，尚未解除。PR 只有初始工單、沒有實作結果。兩項 CI 成功不能代替實作驗收；主管已留下 [blocked 回條](https://github.com/Fadinggo/race/pull/2#issuecomment-6509634422)，保留 PR 並暫停 smoke 事件例行程序。未啟用獨立付費 API 替代方案。

## 分工與流程

主管負責辨識問題、訂定允許修改範圍與驗收標準；Codex 雲端工作負責實作、測試及回報；主管核對結果後決定接受或退回。正式網站的唯讀資料採集仍由既有 GitHub Actions 處理。

1. 主管使用已連接的 GitHub 帳戶在 `Fadinggo/race` 建立 Issue，加入 `codex-maintenance` 標籤，並放入下列唯一一段工單 JSON。
2. `maintenance-dispatch.yml` 驗證儲存庫、作者、觸發者與工單格式，從最新 `main` 建立 `codex/maintenance-N`，只新增不可變更的工單檔案，並在 Issue 留下準備完成回條與初始 commit。
3. 主管在建立 Issue 的當次工作中有界等候完成回條；若準備仍排隊，安排一次性延後檢查，不假設 Issue 留言會喚醒主管。讀取回條後，使用現有 GitHub 連接器建立該分支到 `main` 的 PR。準備流程不以 `GITHUB_TOKEN` 建立 PR，以免形成需要人工批准才執行的檢查。（GitHub，無日期）
4. 主管先建立範圍限定該 PR 的 Grok 原生事件例行程序，再在 PR 發送 `@codex` 實作要求。官方 GitHub 整合支援從 PR 留言啟動雲端工作，前提是已連接該程式碼庫。（OpenAI，無日期）例行程序關注 PR 留言、審查與 CI 完成事件；實際能否回報仍需端到端驗證。
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
- 初始連線測試不自動合併；主管完成驗收後關閉測試 PR，保留 Issue 與 PR 作證據。

## 邊界與故障處理

自動派工不存取 OKX Secrets，不交易、不調整交易服務、不更換帳戶、不重設歷史，也不修改自身派工權限或工作流程。需要上述變更時回報明確阻塞，交由另行審查的工作處理。

這條路徑使用 Codex 雲端工作，不會喚醒使用者電腦上的某個既有聊天。GitHub 與 Grok 的雲端事件、Codex 帳戶連線及可用額度皆需正常。沒有事件到達、排隊延遲、額度不足或 GitHub 連線失效時，不得聲稱維護已完成。

派工失敗可查看該 Issue 的 Actions 執行；修正可恢復的服務問題後，以手動 workflow dispatch 指定同一 Issue 重試。不得 force-push、覆蓋既有工單或偽造準備回條。若分支／摘要不一致，先保留證據並回報主管。

範圍檢查使用公開 GitHub API 取得準備回條；遇到限流或服務錯誤會拒絕通過，需稍後重跑。可信範圍檢查的工作流程由 `pull_request_target` 取正式基底版本，避免 PR 移除自己的檢查；該工作不執行 PR 測試。本方案未建立 branch rules，具有儲存庫寫入權限的帳號仍可直接操作主分支；因此檢查程式不是完整的權限隔離，主管仍需審查完整變更及其行為，尤其測試檔也是可執行程式。

GitHub 更新流程部署的是 `main`，因此一般修正經主管接受並合併後，仍需觀察下一次正式更新與 Pages 發布結果，才能稱為網站修復完成。

## 參考文獻

OpenAI. (無日期). *GitHub*. https://learn.chatgpt.com/docs/third-party/github

GitHub. (無日期). *GITHUB_TOKEN*. https://docs.github.com/en/actions/concepts/security/github_token
