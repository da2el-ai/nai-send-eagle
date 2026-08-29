// ============================================================
// 定数
// ============================================================
const LOG_PREFIX = "[NAI Send Eagle]";
// inpaint 時に historyContainer が消えるため、それより上位の .image-gen-body を監視起点にする
const HISTORY_ROOT_SELECTOR = ".image-gen-body";
// ディレクターツール（表情変換など）の生成ボタン
// ページ内の .image-gen-generate-button は2個あるため、ツール側に限定する
const DIRECTOR_TOOL_BUTTON_SELECTOR = ".image-gen-tools .image-gen-generate-button";

// 新規画像が現れるまでの待機設定（最大 20 回 × 150ms = 3秒）
const NEW_IMAGE_MAX_RETRIES = 20;
const NEW_IMAGE_INTERVAL = 150;
// ディレクターツールはボタン押下から生成完了までを待つため長めにする（最大 400 回 × 150ms = 60秒）
const DIRECTOR_TOOL_MAX_RETRIES = 400;
// 複数枚生成で残りの画像が出揃うのを待つ設定（変化し続ける限り最大 5 回 × 400ms = 2秒）
const SETTLE_MAX_ROUNDS = 5;
const SETTLE_INTERVAL = 400;
// 重複送信の判定に使うハッシュ履歴の保持件数
const SENT_HASH_HISTORY_SIZE = 30;

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
 * @returns {Promise<{eagleFolderName: string, eagleFolderId: string, debugLog: boolean, sentImageHashes: string[]}>}
 */
async function loadSettings() {
  return await chrome.storage.local.get([
    "eagleFolderName",
    "eagleFolderId",
    "debugLog",
    "sentImageHashes",
  ]);
}

/**
 * 送信済み画像のハッシュ値を履歴に追加する
 * inpaint では同じ画像が複数の blob として現れるため、直前の1件だけでは重複を防げない
 * @param {string} hash - SHA-256 ハッシュ文字列
 */
async function addSentImageHash(hash) {
  const { sentImageHashes = [] } = await loadSettings();
  const updated = [...sentImageHashes.filter((h) => h !== hash), hash];
  // 古いものから捨てて上限件数に収める
  await chrome.storage.local.set({
    sentImageHashes: updated.slice(-SENT_HASH_HISTORY_SIZE),
  });
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

// ============================================================
// 生成画像の特定（blob URL の新規判定）
// ============================================================

/**
 * 生成開始時点で DOM にあった blob URL の集合
 * ここに無い blob 画像を「今回生成された画像」とみなす
 * @type {Set<string>}
 */
let knownBlobSrcs = new Set();

/** 生成イベントの通し番号。非同期処理をまたいでログを対応付けるために使う */
let generationSeq = 0;

/**
 * blob URL の末尾だけを短く取り出す（ログの識別用）
 * @param {string} src - blob URL
 * @returns {string}
 */
function shortBlobId(src) {
  return src.slice(-12);
}

/**
 * 現在 DOM にある blob <img> 要素の一覧を返す
 * @returns {HTMLImageElement[]}
 */
function getBlobImages() {
  return Array.from(document.querySelectorAll('img[src^="blob:"]'));
}

/**
 * 既知の blob URL を現在の DOM の状態で更新する
 * 生成開始時に呼ぶことで、それ以降に現れた画像を新規として判別できる
 */
function refreshKnownBlobSrcs() {
  knownBlobSrcs = new Set(getBlobImages().map((img) => img.src));
}

/**
 * 既知の blob URL に含まれない画像（＝今回新しく現れた画像）を返す
 * @returns {HTMLImageElement[]}
 */
function collectNewBlobImages() {
  return getBlobImages().filter((img) => !knownBlobSrcs.has(img.src));
}

/**
 * 新規画像から生成結果だけを選び出す
 * inpaint ではマスク画像やキャンバスの元画像も新しい blob として現れるため、
 * 生成結果グリッドの画像があればそれだけに絞る
 * @param {HTMLImageElement[]} newImgs - 新規に現れた画像
 * @returns {HTMLImageElement[]}
 */
function selectGeneratedImages(newImgs) {
  const gridImgs = newImgs.filter((img) => img.classList.contains("image-grid-image"));
  return gridImgs.length > 0 ? gridImgs : newImgs;
}

/**
 * 画像要素の状態をログ用にまとめる
 * @param {HTMLImageElement} img - 対象の画像要素
 * @returns {{id: string, cls: string, size: string}}
 */
function describeImage(img) {
  return {
    id: shortBlobId(img.src),
    cls: img.className || "(クラスなし)",
    size: `${img.naturalWidth}x${img.naturalHeight}`,
  };
}

/**
 * 指定ミリ秒待機する
 * @param {number} ms - 待機時間(ms)
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 今回生成された blob <img> 要素の一覧を返す
 * 生成開始時点に無かった blob URL を新規画像とみなすため、
 * DOM の並び順や枚数の変化に影響されない
 * @param {number} [seq] - ログ用の生成イベント通し番号
 * @param {number} [maxRetries] - 新規画像が現れるまでの最大リトライ回数
 * @returns {Promise<HTMLImageElement[]>}
 */
async function identifyGeneratedImages(seq = 0, maxRetries = NEW_IMAGE_MAX_RETRIES) {
  // 新規画像が現れるまで待つ
  let newImgs = [];
  for (let i = 0; i < maxRetries; i++) {
    newImgs = collectNewBlobImages();
    if (newImgs.length > 0) break;
    await sleep(NEW_IMAGE_INTERVAL);
  }
  if (newImgs.length === 0) return [];

  // 画像は順次現れるため、顔ぶれが変わらなくなるまで待つ
  // （枚数が同じでもマスクから生成結果へ入れ替わることがあるため URL で比較する）
  let signature = newImgs.map((img) => img.src).join();
  for (let i = 0; i < SETTLE_MAX_ROUNDS; i++) {
    await sleep(SETTLE_INTERVAL);
    const next = collectNewBlobImages();
    const nextSignature = next.map((img) => img.src).join();
    if (nextSignature === signature) break;
    newImgs = next;
    signature = nextSignature;
  }

  const targets = selectGeneratedImages(newImgs);
  await logDebug(`[identify #${seq}] 新規 ${newImgs.length} 枚 → 送信対象 ${targets.length} 枚`, {
    新規: newImgs.map(describeImage),
    送信対象: targets.map((img) => shortBlobId(img.src)),
  });
  return targets;
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
  const { sentImageHashes = [], eagleFolderId, eagleFolderName } = await loadSettings();
  await logDebug(`[processSendFlow] 送信先フォルダ: name="${eagleFolderName ?? "(未設定)"}" id="${eagleFolderId ?? "(なし)"}"`);

  const isDuplicate = sentImageHashes.includes(currentHash);
  await logDebug("[processSendFlow] ハッシュ比較:", JSON.stringify({
    今回: currentHash.slice(0, 12),
    履歴件数: sentImageHashes.length,
    送信済み: isDuplicate,
    サイズ: base64.length,
  }));

  if (isDuplicate) {
    await logDebug("送信済みの画像のためスキップしました");
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
    await addSentImageHash(currentHash);
  }
}

// ============================================================
// 生成イベントの処理
// ============================================================

/** 生成イベントを到着順に直列処理するためのキュー */
let generationQueue = Promise.resolve();

/**
 * 生成イベントの処理をキューに積む
 * 送信処理中に次の生成が始まっても基準の blob URL がずれないよう、必ず順番に実行する
 * @param {() => Promise<void>} handler - 実行する処理
 */
function enqueueGenerationEvent(handler) {
  generationQueue = generationQueue
    .then(handler)
    .catch((error) => logError("生成イベントの処理に失敗しました", error));
}

/**
 * 生成開始時の処理
 * この時点の blob URL を基準として記録する
 */
async function handleGenerationStart() {
  refreshKnownBlobSrcs();
  await logDebug(`[Observer] 生成開始を検知。基準の blob 画像 ${knownBlobSrcs.size} 枚を記録しました`);
}

/**
 * 新規画像を特定して Eagle へ送信する
 * @param {string} label - ログに出すトリガー名
 * @param {number} maxRetries - 新規画像が現れるまでの最大リトライ回数
 */
async function sendNewImages(label, maxRetries) {
  const seq = ++generationSeq;
  await logDebug(`[${label} #${seq}] 生成完了を検知`);

  const imgEls = await identifyGeneratedImages(seq, maxRetries);
  if (imgEls.length === 0) {
    await logWarn(`[${label} #${seq}] 新規の生成画像が見つかりませんでした`);
    return;
  }

  // 複数枚ある場合は順番に送信する
  for (const imgEl of imgEls) {
    await logDebug(`[${label} #${seq}] processSendFlow 開始:`, shortBlobId(imgEl.src));
    await processSendFlow(imgEl);
  }

  // 送信済みの画像を既知として扱い、次の生成で再送しないようにする
  refreshKnownBlobSrcs();
}

/**
 * 生成完了時の処理（削除ボタンの disabled 解除がトリガー）
 * 基準に無い blob 画像を新規とみなして Eagle へ送信する
 */
async function handleGenerationComplete() {
  await sendNewImages("Observer", NEW_IMAGE_MAX_RETRIES);
}

/**
 * ディレクターツールの生成ボタンが押された時の処理
 * このツールでは削除ボタンの disabled が変化せず生成完了を検知できないため、
 * クリック時点を基準にして新規画像が現れるまで待つ
 * @param {Set<string>} baseSrcs - クリック時点の blob URL（キュー待ちの間にずれないよう呼び出し元で取得する）
 */
async function handleDirectorToolClick(baseSrcs) {
  // クリック時点ではまだ変換前なので、ここを基準にすれば結果だけが新規になる
  knownBlobSrcs = baseSrcs;
  await logDebug(`[DirectorTool] 生成ボタンのクリックを検知。基準の blob 画像 ${knownBlobSrcs.size} 枚`);
  await sendNewImages("DirectorTool", DIRECTOR_TOOL_MAX_RETRIES);
}

// ============================================================
// ディレクターツールの監視
// ============================================================

/**
 * ディレクターツールの生成ボタンのクリック監視を開始する
 * ボタンは SPA の再描画で作り直されるため、document 側で受け取る
 */
function startDirectorToolWatcher() {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest(DIRECTOR_TOOL_BUTTON_SELECTOR)) return;
      // 基準はクリックした瞬間の状態で取る（キューの順番待ちで変換後になるのを防ぐ）
      const baseSrcs = new Set(getBlobImages().map((img) => img.src));
      enqueueGenerationEvent(() => handleDirectorToolClick(baseSrcs));
    },
    // 生成ボタン側で伝播が止められても拾えるようにキャプチャ段階で受け取る
    true
  );

  logDebug("ディレクターツールの生成ボタンの監視を開始しました");
}

// ============================================================
// MutationObserver の設定
// ============================================================

/**
 * 履歴コンテナの監視を開始する（最大50回リトライ）
 * @param {number} [retryCount=0] - 現在のリトライ回数
 */
function startObserver(retryCount = 0) {
  // historyContainer は inpaint 時に差し替えられるため、上位の .image-gen-body を監視する
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

  const observer = new MutationObserver((mutations) => {
    // 削除ボタンの disabled が付いた時を生成開始、外れた時を生成完了とみなす
    // （txt2img・inpaint 共通）
    let isGenerationStart = false;
    let isGenerationComplete = false;
    for (const m of mutations) {
      if (m.type !== "attributes" || m.attributeName !== "disabled") continue;
      if (!(m.target instanceof Element)) continue;
      if (m.target.getAttribute("aria-label") !== "delete image(s)") continue;
      if (m.target.hasAttribute("disabled")) {
        isGenerationStart = true;
      } else {
        isGenerationComplete = true;
      }
    }

    // 生成開始時点の blob URL を記録し、これ以降に現れた画像を新規と判別する
    // 完了が同じバッチに含まれる場合は基準を更新しない（新規画像を見失うため）
    if (isGenerationStart && !isGenerationComplete) {
      enqueueGenerationEvent(handleGenerationStart);
      return;
    }

    if (isGenerationComplete) {
      enqueueGenerationEvent(handleGenerationComplete);
    }
  });

  // .image-gen-body 全体を監視する（inpaint 時に historyContainer が差し替えられても対応するため）
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
  });

  // 監視開始時点で表示中の画像を既知として扱い、初回生成で誤送信しないようにする
  refreshKnownBlobSrcs();

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
startDirectorToolWatcher();
