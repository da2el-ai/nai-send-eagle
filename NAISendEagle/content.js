// ============================================================
// 定数
// ============================================================
const LOG_PREFIX = "[NAI Send Eagle]";
// inpaint 時に historyContainer が消えるため、それより上位の .image-gen-body を監視起点にする
const HISTORY_ROOT_SELECTOR = ".image-gen-body";
// 履歴アイテムのコンテナ（historyContainer 直下の div[2]）
const HISTORY_CONTAINER_XPATH = '//*[@id="historyContainer"]/div[2]';
// querySelector で取得した要素からの相対パス
const MAIN_PROMPT_TEXT_XPATH = './/div[2]/div[1]/div/div/p';
const CHARACTER_PROMPT_TEXT_XPATH = './/div[2]/div[3]/div/div[1]';
const CHARACTER_LABEL_XPATH = './/div[1]/span';

// メッセージ種別の定数定義
const MESSAGE_TYPE = {
  HEALTH_CHECK_FAILED: "HEALTH_CHECK_FAILED",
  SEND_TO_EAGLE: "SEND_TO_EAGLE",
};

// ============================================================
// ログ出力ユーティリティ
// ============================================================

/**
 * デバッグ設定を考慮して通常ログを出力する
 * @param {...any} args - ログに出力する値
 */
async function logDebug(...args) {
  const { debugLog } = await loadSettings();
  if (debugLog) console.log(LOG_PREFIX, ...args);
}

/**
 * デバッグ設定を考慮して警告ログを出力する
 * @param {...any} args - ログに出力する値
 */
async function logWarn(...args) {
  const { debugLog } = await loadSettings();
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
 * 設定値をすべて取得する
 * @returns {Promise<{eagleFolderName: string, eagleFolderId: string, debugLog: boolean, lastImageHash: string}>}
 */
async function loadSettings() {
  return await chrome.storage.local.get([
    "eagleFolderName",
    "eagleFolderId",
    "debugLog",
    "lastImageHash",
  ]);
}

/**
 * 最後に送信した画像のハッシュ値を保存する
 * @param {string} hash - SHA-256 ハッシュ文字列
 */
async function saveLastImageHash(hash) {
  await chrome.storage.local.set({ lastImageHash: hash });
}

// ============================================================
// ハッシュ生成
// ============================================================

/**
 * 文字列から SHA-256 ハッシュを生成する
 * @param {string} text - ハッシュ化する文字列
 * @returns {Promise<string>} 16進数ハッシュ文字列
 */
async function generateHash(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// DOM ユーティリティ
// ============================================================

/**
 * XPath を使って最初に一致する要素を返す
 * @param {string} xpath - XPath 文字列
 * @param {Node} [context=document] - 検索の起点となるノード
 * @returns {Element|null}
 */
function getElementByXPath(xpath, context = document) {
  return document.evaluate(
    xpath,
    context,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null
  ).singleNodeValue;
}

/**
 * XPath を使って一致するすべての要素を返す
 * @param {string} xpath - XPath 文字列
 * @param {Node} [context=document] - 検索の起点となるノード
 * @returns {Element[]}
 */
function getElementsByXPath(xpath, context = document) {
  const result = document.evaluate(
    xpath,
    context,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  );
  const elements = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    elements.push(result.snapshotItem(i));
  }
  return elements;
}

// ============================================================
// 画像データの取得
// ============================================================

/**
 * 監視起点（.image-gen-body）を返す
 * inpaint 時に historyContainer が消えてもこの要素は消えない
 * @returns {Element|null}
 */
function getHistoryRoot() {
  return document.querySelector(HISTORY_ROOT_SELECTOR);
}

/**
 * 履歴コンテナの要素を返す
 * @returns {Element|null} 履歴コンテナ要素
 */
function getHistoryContainer() {
  return getElementByXPath(HISTORY_CONTAINER_XPATH);
}

/**
 * 履歴コンテナから先頭アイテム（最初の子要素）を返す
 * @returns {Element|null} 先頭の履歴アイテム要素
 */
function getFirstHistoryItem() {
  return getHistoryContainer()?.firstElementChild ?? null;
}

/**
 * 生成結果の blob <img> 要素の一覧を返す
 * パターンにより取得対象を変える:
 *   1. 全て image-grid-image → 別バージョン生成：2番目以降
 *   2. 一部のみ image-grid-image → 通常/inpaint：image-grid-image だけ
 *   3. 全て className なし → デクラッター：3番目決め打ち
 * @param {number} maxRetries - 最大リトライ回数
 * @param {number} interval - リトライ間隔(ms)
 * @returns {Promise<HTMLImageElement[]>}
 */
function identifyGeneratedImages(maxRetries = 20, interval = 150) {
  return new Promise((resolve) => {
    let count = 0;
    const check = () => {
      const all = Array.from(document.querySelectorAll('img[src^="blob:"]'));
      const gridImgs = all.filter((img) => img.classList.contains("image-grid-image"));

      let targets;
      if (all.length === 0) {
        // まだ画像が現れていないので待機する
        targets = null;
      } else if (gridImgs.length === all.length && all.length > 1) {
        // 全て image-grid-image かつ複数 → 別バージョン生成: 2番目以降
        targets = gridImgs.slice(1);
      } else if (gridImgs.length > 0) {
        // image-grid-image が 1枚以上存在 → 通常/inpaint
        targets = gridImgs;
      } else {
        // 全て className なし → デクラッター: 3番目決め打ち
        targets = all.length > 2 ? [all[2]] : null;
      }

      // デバッグ用（check は同期関数のため console.log を直接使う）
      loadSettings().then(({ debugLog }) => {
        if (debugLog) console.log(LOG_PREFIX, "[identifyGeneratedImages]", JSON.stringify({
          total: all.length,
          gridImgs: gridImgs.length,
          targets: targets?.length ?? 0,
        }));
      });

      if (targets && targets.length > 0) {
        resolve(targets);
        return;
      }
      if (++count >= maxRetries) {
        resolve([]);
        return;
      }
      setTimeout(check, interval);
    };
    check();
  });
}

/**
 * Blob を base64 文字列（data: スキーム含む）に変換する
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * blob <img> 要素から base64 文字列を取得する
 * @param {HTMLImageElement} imgEl
 * @returns {Promise<string|null>}
 */
async function fetchBase64FromImageEl(imgEl) {
  try {
    const response = await fetch(imgEl.src);
    const blob = await response.blob();
    return await blobToBase64(blob);
  } catch (error) {
    logError("blob の取得に失敗しました", error);
    return null;
  }
}

// ============================================================
// プロンプトの収集
// ============================================================

/**
 * メインプロンプトのテキストを取得する
 * @returns {string} プロンプトの純粋なテキスト（取得失敗時は空文字）
 */
/**
 * メインプロンプトのテキストを取得する
 * querySelector で先頭の要素を取得し、相対 XPath でテキストを抽出する
 * @returns {string} プロンプトの純粋なテキスト（取得失敗時は空文字）
 */
function getMainPromptText() {
  // 先頭の要素のみ取得する（2番目はミラーなので除外）
  const area = document.querySelector(".image-gen-prompt-main");
  if (!area) return "";
  const paragraphs = getElementsByXPath(MAIN_PROMPT_TEXT_XPATH, area);
  return paragraphs.map((p) => p.textContent).join("\n");
}

/**
 * 現在表示中のメインプロンプト種別ラベルを返す
 * .image-gen-prompt-main 内の prompt-input-box- プレフィックスを持つクラスから取得する
 * @returns {string} プロンプト種別ラベル（例: "ベースプロンプト"、"除外したい要素"）
 */
function getMainPromptLabel() {
  const el = document.querySelector(".image-gen-prompt-main [class*='prompt-input-box-']");
  if (!el) return "Prompt";
  // クラス名から "prompt-input-box-" を除いた部分をラベルとして使う
  const cls = Array.from(el.classList).find((c) => c.startsWith("prompt-input-box-"));
  return cls ? cls.replace("prompt-input-box-", "") : "Prompt";
}

/**
 * 有効なキャラクタープロンプトの一覧を取得する
 * ミラーリング対策として前半分のみ使用する
 * @returns {{label: string, text: string}[]} キャラクタープロンプトの配列
 */
function getCharacterPrompts() {
  const allAreas = document.querySelectorAll(".character-prompt-input");
  // ミラーリング対策として前半分のみを使用する
  const areas = Array.from(allAreas).slice(0, Math.ceil(allAreas.length / 2));
  const results = [];

  for (const area of areas) {
    // 非表示・無効化されたエリアをスキップする
    if (area.style.display === "none") continue;
    if (area.style.opacity === "0.5") continue;

    // 見出しラベル（「キャラクター1」など）を span から取得する
    const labelNode = getElementsByXPath(CHARACTER_LABEL_XPATH, area)[0];
    const label = labelNode?.textContent?.trim() ?? `Character ${results.length + 1}`;

    // querySelector で取得した area を起点に相対 XPath でテキストを取得する
    const nodes = getElementsByXPath(CHARACTER_PROMPT_TEXT_XPATH, area);
    const text = nodes.map((n) => n.textContent).join("\n");

    results.push({ label, text });
  }
  return results;
}

/**
 * プロンプト情報からメモテキストを生成する
 * @param {string} mainText - メインプロンプトのテキスト
 * @param {string} mainLabel - メインプロンプトの種別ラベル（例: "ベースプロンプト"、"除外したい要素"）
 * @param {{label: string, text: string}[]} characterPrompts - キャラクタープロンプトの配列
 * @returns {string} メモテキスト
 */
function buildMemoText(mainText, mainLabel, characterPrompts) {
  const lines = [];

  lines.push(`# Prompt (${mainLabel})`);
  lines.push(mainText);

  characterPrompts.forEach(({ label, text }) => {
    lines.push(`\n# ${label}`);
    lines.push(text);
  });

  return lines.join("\n");
}

// ============================================================
// Eagle API
// ============================================================

/**
 * Eagle へ画像データを送信する
 * @param {string} base64 - 送信する画像の base64 文字列（data: スキーム含む）
 * @param {string} annotation - メモテキスト
 * @param {string|null} folderId - 送信先フォルダID（null の場合は省略）
 * @returns {Promise<boolean>} 送信成功なら true
 */
async function sendImageToEagle(base64, annotation, folderId) {
  try {
    // CORS 回避のため fetch は background.js（Service Worker）側で行う
    const result = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.SEND_TO_EAGLE,
      payload: { base64, annotation, folderId },
    });
    if (result?.success) {
      await logDebug("Eagle への送信が成功しました");
      return true;
    }
    logError("Eagle への送信に失敗しました", result?.error ?? "不明なエラー");
    alert("Eagle への送信に失敗しました。Eagle が起動しているか確認してください。");
    return false;
  } catch (error) {
    logError("Eagle への送信に失敗しました", error);
    alert("Eagle への送信に失敗しました。Eagle が起動しているか確認してください。");
    return false;
  }
}

// ============================================================
// 画像送信フロー
// ============================================================

/**
 * 画像送信フローを実行する
 * 重複チェック → プロンプト収集 → Eagle 送信 → ハッシュ更新
 * @param {HTMLImageElement} imgEl - 送信対象の <img> 要素
 */
async function processSendFlow(imgEl) {
  const base64 = await fetchBase64FromImageEl(imgEl);
  if (!base64) {
    await logWarn("[processSendFlow] base64 取得失敗");
    return;
  }
  await logDebug("[processSendFlow] base64 取得成功。先頭50文字:", base64.slice(0, 50));

  // 重複チェック用のハッシュを生成する
  const currentHash = await generateHash(base64);
  const { lastImageHash, eagleFolderId, eagleFolderName } = await loadSettings();
  await logDebug(`[processSendFlow] 送信先フォルダ: name="${eagleFolderName ?? "(未設定)"}" id="${eagleFolderId ?? "(なし)"}"`);

  if (currentHash === lastImageHash) {
    await logDebug("同一画像のため送信をスキップしました");
    return;
  }

  // プロンプト情報を収集してメモを生成する
  const mainText = getMainPromptText();
  const mainLabel = getMainPromptLabel();
  const characterPrompts = getCharacterPrompts();
  const annotation = buildMemoText(mainText, mainLabel, characterPrompts);

  await logDebug("メモ内容:\n", annotation);

  const success = await sendImageToEagle(base64, annotation, eagleFolderId || null);
  await logDebug("Eagle 送信結果:", success ? "成功" : "失敗");
  if (success) {
    await saveLastImageHash(currentHash);
  }
}

// ============================================================
// MutationObserver の設定
// ============================================================

/**
 * 履歴コンテナの監視を開始する（最大50回リトライ）
 * @param {number} [retryCount=0] - 現在のリトライ回数
 */
function startObserver(retryCount = 0) {
  // div[2] は剰替される可能性があるため、#historyContainer 自体を監視する
  const root = getHistoryRoot();
  if (!root) {
    if (retryCount === 0) {
      logDebug(".image-gen-body を待機中...");
    }
    if (retryCount >= 50) {
      console.error(LOG_PREFIX, ".image-gen-body が見つかりませんでした。セレクタを確認してください:", HISTORY_ROOT_SELECTOR);
      return;
    }
    setTimeout(() => startObserver(retryCount + 1), 1000);
    return;
  }

  const observer = new MutationObserver(async (mutations) => {
    // 削除ボタンから disabled が外れた時を生成完了とみなす（txt2img・inpaint 共通）
    const isGenerationComplete = mutations.some((m) =>
      m.type === "attributes" &&
      m.attributeName === "disabled" &&
      m.target instanceof Element &&
      m.target.getAttribute("aria-label") === "delete image(s)" &&
      !m.target.hasAttribute("disabled")
    );

    if (!isGenerationComplete) return;

    // disabled 削除直後はまだ画像が現れていないため少し待つ
    await new Promise((resolve) => setTimeout(resolve, 500));

    // パターンに応じて生成結果画像を特定する
    const imgEls = await identifyGeneratedImages();
    await logDebug("[Observer] identifyGeneratedImages 結果:", imgEls.length, "枚");
    if (imgEls.length === 0) {
      await logWarn("生成結果画像が見つかりませんでした");
      return;
    }
    // 複数枚ある場合は順番に送信する
    for (const imgEl of imgEls) {
      await logDebug("[Observer] processSendFlow 開始:", imgEl.src.slice(0, 80));
      await processSendFlow(imgEl);
    }
  });

  // .image-gen-body 全体を監視する（inpaint 時に historyContainer が剰替されても対応するため）
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
  });

  logDebug("MutationObserver の監視を開始しました");
}

// ============================================================
// background.js からのメッセージ受信
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MESSAGE_TYPE.HEALTH_CHECK_FAILED) {
    alert("Eagle へ接続できません。Eagle が起動しているか確認してください。");
  }
});

// ============================================================
// 初期化
// ============================================================
logDebug("Content Script が起動しました。監視を開始します...");
startObserver();
