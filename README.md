# NAI Send Eagle

<figure style="text-align:center">
<img src="./NAISendEagle/icon.png" style="width:10rem;">
</figure>

NovelAI で生成した画像を自動で [Eagle](https://jp.eagle.cool/) へ送信する Chrome 拡張機能です。

ポジティブプロンプト、キャラクタープロンプトをEagleのメモとして保存します。

---

## 必要環境

| 項目 | バージョン |
|------|-----------|
| Chrome | 最新推奨<br>Microsoft Edgeは動作未確認 |
| [Eagle](https://jp.eagle.cool/) | **4.0 Build 21 以上**（Eagle Web API v2 を使用しているため） |

> **注意:** Eagle 4.0 Build 21 未満のバージョンでは動作しません。

---

## インストール方法

1. [Releases](https://github.com/da2el-ai/nai-send-eagle/releases) から最新の `NAISendEagle-vX.X.X.zip` をダウンロード
2. ZIP を解凍する
3. Chrome で `chrome://extensions` を開く
4. 右上の **デベロッパーモード** をオンにする
5. **「パッケージ化されていない拡張機能を読み込む」** をクリック
6. 解凍した `NAISendEagle` フォルダを選択する

---

## 使い方

1. Eagle を起動する
2. Chrome で [NovelAI](https://novelai.net/image) を開く
3. 画像を生成する
4. 生成完了と同時に、自動で Eagle へ画像が送信される

---

## 設定

ツールバーのアイコンをクリックすると設定画面が開きます。

### 保存先フォルダ名

Eagle 内の送信先フォルダ名を指定します。

- 空欄の場合は（未分類）に保存されます
- **フォルダ名は大文字・小文字を区別します**（例: `NovelAI` と `novelai` は別フォルダとして扱われます）
- 存在しないフォルダ名を入力して保存すると警告が表示されます

### デバッグログ

オンにすると、Chrome の DevTools コンソール（`F12` / `Cmd + Opt + I`）に動作ログが出力されます。動作確認や不具合調査の際に使用してください。

---

## プロンプトの保存について

送信時、Eagle のアイテムメモ欄に生成時のプロンプト内容が記録されます。

- **記録される内容:** メインプロンプト（ベースプロンプトなど）・キャラクタープロンプト
- **記録されない内容:** ネガティブプロンプト
- **プロンプトが存在しない場合（デクラッター機能など）:** メモ欄は空になります

---

## 注意事項

- Eagle が起動していない状態で画像を生成すると、送信失敗のアラートが表示されます
- Chrome ストア未公開のため、デベロッパーモードを有効にする必要があります
- 自動更新はありません。新バージョンは [Releases](../../releases) を確認してください

---

## ライセンス

[MIT License](LICENSE)
