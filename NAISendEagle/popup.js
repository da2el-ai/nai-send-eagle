// ============================================================
// chrome.storage ラッパー
// ============================================================

/**
 * 設定値をすべて読み込む
 * @returns {Promise<{eagleFolderName: string, debugLog: boolean}>}
 */
async function loadSettings() {
  return await chrome.storage.local.get(["eagleFolderName", "debugLog"]);
}

/**
 * 設定値を保存する
 * @param {string} folderName - Eagle フォルダ名
 * @param {string|null} folderId - Eagle フォルダID
 * @param {boolean} isDebugEnabled - デバッグログ表示設定
 */
async function saveSettings(folderName, folderId, isDebugEnabled) {
  await chrome.storage.local.set({
    eagleFolderName: folderName,
    eagleFolderId: folderId ?? "",
    debugLog: isDebugEnabled,
  });
}

// ============================================================
// UI 操作
// ============================================================

/**
 * 保存完了メッセージを一定時間表示して非表示にする
 */
function showSavedMessage() {
  const el = document.getElementById("saveMessage");
  el.textContent = "保存しました";
  setTimeout(() => {
    el.textContent = "";
  }, 2000);
}

// ============================================================
// 初期化
// ============================================================

/**
 * ポップアップ起動時に保存済みの設定値をフォームへ反映する
 */
async function initForm() {
  const { eagleFolderName, debugLog } = await loadSettings();
  document.getElementById("folderName").value = eagleFolderName ?? "";
  document.getElementById("debugLog").checked = debugLog ?? false;
}

/**
 * フォルダ名を Eagle で解決してIDを返す
 * background.js 経由で Eagle API を呼び出す（CORS 回避）
 * @param {string} folderName
 * @returns {Promise<string|null>} フォルダID（見つからない場合は null）
 */
async function resolveFolderId(folderName) {
  const result = await chrome.runtime.sendMessage({
    type: "RESOLVE_FOLDER",
    folderName,
  });
  return result?.folderId ?? null;
}

/**
 * 保存ボタンのクリックハンドラ
 */
async function handleSaveClick() {
  const folderName = document.getElementById("folderName").value.trim();
  const isDebugEnabled = document.getElementById("debugLog").checked;

  // フォルダ名が入力されている場合は存在確認してIDを取得する
  let folderId = null;
  if (folderName) {
    folderId = await resolveFolderId(folderName);
    if (folderId == null) {
      alert(`"${folderName}" は存在しませんでした`);
      return;
    }
  }

  await saveSettings(folderName, folderId, isDebugEnabled);
  showSavedMessage();
}

// ============================================================
// イベント登録
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  initForm();
  document.getElementById("saveButton").addEventListener("click", handleSaveClick);
});
