# nero-terminal

PuTTY / Tera Term 風の SSH・ローカルシェル ターミナル。

- 公式サイト: <https://informanellica.github.io/nero-terminal/>
- ソースコードドキュメント (JSDoc): <https://informanellica.github.io/nero-terminal/src/>
- 最新版ダウンロード: <https://github.com/informanellica/nero-terminal/releases/latest>

## 主な機能

- SSH 接続とローカルシェル (PowerShell / bash など) を 1 アプリで
- 保存済みセッション (接続先・認証・表示設定を名前付きで保存し再接続)
- SSH 認証: パスワード / 秘密鍵 (パスフレーズ対応) / 端末上での対話ログイン
- 配色テーマ・フォント・カーソル形状 (ブロック / 下線 / 縦棒)・点滅・ライト / ダーク切替
- スクロールバック行数・端末サイズ (桁数 × 行数)・端末種別文字列などの設定
- 日本語 / 英語 UI

## 開発

共有ライブラリは git サブモジュールとして `nero_modules/` 配下に取り込みます。

```sh
# サブモジュールを含めて取得
git submodule update --init --recursive

# 依存関係のインストール (preinstall でサブモジュールも更新)
npm install

# 起動
npm start

# スモークテスト
npm test
```

## ビルド

[electron-builder](https://www.electron.build/) で配布パッケージを生成します。

```sh
npm run build          # Windows リリース版 → dist/
npm run build:debug    # Windows デバッグ版  → dist-debug/
npm run build:mac      # macOS リリース版    → dist-mac/ (.dmg / .zip, arm64)
npm run build:mac:debug # macOS デバッグ版   → dist-mac-debug/ (署名・公証なし)
```

### macOS の署名・公証

リリース版 (`build:mac`) は Developer ID で署名し、Apple の公証 (notarization) まで行います。
公証には App Store Connect API キー (`APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`)
を環境変数で設定してからビルドします。

```sh
export APPLE_API_KEY=/path/to/AuthKey.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
npm run build:mac
```

- ハードンドランタイムと JIT 用 entitlements は electron-builder の既定値で自動付与されます。
- 上記環境変数が未設定の場合、署名のみ行い公証はスキップします (ビルドは成功)。
- デバッグ版 (`build:mac:debug`) は署名・公証ともに行いません。

### Windows の署名

署名付きリリースは**非公開側のビルドスクリプト**から、`runBuild` の `configHook` で
証明書の拇印をメモリ上に注入して行います（公開設定ファイルは書き換えず、環境変数も不要）。

```js
// 非公開側ビルドスクリプト (抜粋)
runBuild({
  projectDir, argv: ['release', 'win'],
  configHook: (config) => {
    config.win.signtoolOptions = {
      ...config.win.signtoolOptions,
      certificateSha1: '<thumbprint>',  // 非公開側にのみ存在
    };
  },
});
```

## コーディング規約

- **ソースコードのコメント (JSDoc 含む) は英語のみで書く。** 日本語訳をソースに混在させない。
  多言語ドキュメントは生成時のポスト処理で対応する (下記参照)。

## ドキュメント生成

JSDoc からソースコードのリファレンスを生成します。出力先は公開リポジトリの `release-github/docs/src/` です。

```sh
npm run docs:setup     # 初回のみ: テーマの依存をインストール
npm run docs           # release-github/docs/src/{en,ja}/ に生成
```

ソースコメントは英語 (canonical)。日本語ドキュメントは**ポスト処理**で生成します:
`scripts/jsdoc-i18n-plugin.js` が `DOC_LANG=ja` のとき外部翻訳ファイル
`docs-i18n/ja.json` (doclet longname がキー) を読み、説明・引数・戻り値・プロパティ文を
差し替えます。ソースには翻訳を一切書きません。`npm run docs` は英語版と日本語版の
2 セットを生成し、言語切替リンクを付けます。

`release-github/` は GitHub Pages 用の公開リポジトリ
([github.com/informanellica/nero-terminal](https://github.com/informanellica/nero-terminal)) を
`release` サブモジュールとして取り込んだものです。公式サイト (`docs/index.html`) と
生成ドキュメント (`docs/src/`) を収録しています。

## ライセンス

© Informanellica
