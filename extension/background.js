// ============================================================
// 定数
// ============================================================
const EAGLE_API_BASE_URL = "http://localhost:41595/api/v2";
const HEALTH_CHECK_ALARM_NAME = "healthCheck";
const HEALTH_CHECK_PERIOD_MINUTES = 1;
const LOG_PREFIX = "[NAI Send Eagle]";

// ============================================================
// ログ出力ユーティリティ
// ============================================================

/**
 * デバッグ設定を取得してログを出力する（通常ログ）
 * @param {...any} args - ログに出力する値
 */
async function logDebug(...args) {
  const { debugLog } = await chrome.storage.local.get("debugLog");
  if (debugLog) console.log(LOG_PREFIX, ...args);
}

/**
 * デバッグ設定を取得してログを出力する（警告）
 * @param {...any} args - ログに出力する値
 */
async function logWarn(...args) {
  const { debugLog } = await chrome.storage.local.get("debugLog");
  if (debugLog) console.warn(LOG_PREFIX, ...args);
}

/**
 * エラーログを出力する（デバッグ設定に関わらず常に出力）
 * @param {...any} args - ログに出力する値
 */
function logError(...args) {
  console.error(LOG_PREFIX, ...args);
}

// ============================================================
// chrome.storage ラッパー
// ============================================================

/**
 * Eagle フォルダID のキャッシュを storage に保存する
 * @param {string|null} folderId - 保存するフォルダID（未解決時は null）
 */
async function saveFolderIdCache(folderId) {
  await chrome.storage.local.set({ eagleFolderId: folderId ?? "" });
}

// ============================================================
// Eagle API
// ============================================================

/**
 * Eagle のヘルスチェックを行い、アプリ情報を取得する
 * @returns {Promise<boolean>} Eagle が起動中であれば true
 */
async function checkEagleHealth() {
  try {
    const response = await fetch(`${EAGLE_API_BASE_URL}/app/info`);
    if (!response.ok) {
      throw new Error(`HTTPエラー: ${response.status}`);
    }
    await logDebug("Eagle ヘルスチェック成功");
    return true;
  } catch (error) {
    logError("Eagle ヘルスチェック失敗", error);
    return false;
  }
}

/**
 * Eagle のフォルダ一覧を取得し、指定フォルダ名に対応するIDを返す
 * @param {string} folderName - 検索するフォルダ名
 * @returns {Promise<string|null>} フォルダID（見つからない場合は null）
 */
async function resolveFolderIdByName(folderName) {
  try {
    // v2 API では folder/get を使用する（レスポンスは data.data の配列）
    const response = await fetch(`${EAGLE_API_BASE_URL}/folder/get`);
    if (!response.ok) {
      throw new Error(`HTTPエラー: ${response.status}`);
    }
    const data = await response.json();
    const folder = data.data?.data?.find((f) => f.name === folderName) ?? null;
    if (!folder) {
      await logWarn(`フォルダ "${folderName}" が見つかりませんでした。フォルダ指定なしで送信します。`);
    }
    return folder?.id ?? null;
  } catch (error) {
    logError("フォルダID の解決に失敗しました", error);
    return null;
  }
}

/**
 * Eagle へ画像データを送信する
 * Service Worker 側で fetch するため CORS の制限を受けない
 * @param {string} base64 - base64 文字列（data: スキーム含む）
 * @param {string} annotation - メモテキスト
 * @param {string|null} folderId - 送信先フォルダID
 * @returns {Promise<boolean>} 送信成功なら true
 */
async function sendImageToEagle(base64, annotation, folderId) {
  const payload = {
    base64,
    name: `novelai_${Date.now()}`,
    annotation,
  };
  // v2 API では folders は配列で指定する
  if (folderId) {
    payload.folders = [folderId];
  }

  try {
    const response = await fetch(`${EAGLE_API_BASE_URL}/item/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTPエラー: ${response.status} ${body}`);
    }
    await logDebug("Eagle への送信が成功しました");
    return { success: true };
  } catch (error) {
    logError("Eagle への送信に失敗しました", error);
    return { success: false, error: error.message };
  }
}

// ============================================================
// ヘルスチェック処理（アラームから呼び出される）
// ============================================================

/**
 * ヘルスチェックを実行し、Eagle が起動中であればフォルダIDを解決・保存する
 */
async function runHealthCheck() {
  const isHealthy = await checkEagleHealth();
  if (!isHealthy) {
    // コンテントスクリプトへエラーを通知する
    notifyHealthCheckFailed();
    return;
  }

  const { eagleFolderName } = await chrome.storage.local.get("eagleFolderName");
  if (eagleFolderName) {
    const folderId = await resolveFolderIdByName(eagleFolderName);
    await saveFolderIdCache(folderId);
    await logDebug(`フォルダID を更新しました: ${folderId}`);
  }
}

/**
 * ヘルスチェック失敗をアクティブなタブへ通知する
 */
function notifyHealthCheckFailed() {
  chrome.tabs.query({ url: "https://novelai.net/image*" }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: MESSAGE_TYPE.HEALTH_CHECK_FAILED,
      }).catch(() => {
        // タブが応答できない場合は無視する
      });
    }
  });
}

// ============================================================
// メッセージ種別の定数定義
// ============================================================
const MESSAGE_TYPE = {
  HEALTH_CHECK_FAILED: "HEALTH_CHECK_FAILED",
  SEND_TO_EAGLE: "SEND_TO_EAGLE",
  RESOLVE_FOLDER: "RESOLVE_FOLDER",
};

// ============================================================
// イベントリスナー
// ============================================================

/** 拡張機能インストール時・起動時にアラームを設定する */
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEALTH_CHECK_ALARM_NAME, {
    periodInMinutes: HEALTH_CHECK_PERIOD_MINUTES,
  });
  // インストール直後に一度ヘルスチェックを実行する
  runHealthCheck();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(HEALTH_CHECK_ALARM_NAME, {
    periodInMinutes: HEALTH_CHECK_PERIOD_MINUTES,
  });
});

/** アラーム発火時にヘルスチェックを実行する */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEALTH_CHECK_ALARM_NAME) {
    runHealthCheck();
  }
});

/** content.js からのメッセージを受信する */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MESSAGE_TYPE.SEND_TO_EAGLE) {
    const { base64, annotation, folderId } = message.payload;
    sendImageToEagle(base64, annotation, folderId).then((result) => {
      sendResponse(result);
    });
    // 非同期レスポンスのため true を返す
    return true;
  }
  if (message.type === MESSAGE_TYPE.RESOLVE_FOLDER) {
    resolveFolderIdByName(message.folderName).then((folderId) => {
      sendResponse({ folderId });
    });
    return true;
  }
});
