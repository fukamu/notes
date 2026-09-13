# FUKAMU Notes

紙のカードによるZettelkastenを、1人・1コレクション向けに再現するローカルファーストWebアプリです。カードを一枚ずつ書き、本文中の明示的な一方向リンクを辿りながら考えを深めます。検索、タグ、推薦、被リンクは持ちません。

## 主な機能

- UUIDv7を不変の内部IDにしたカード作成
- オフラインでも即時に付く `仮 #12` 形式のdisplayIdと、同期先による重複しない正式採番
- IndexedDBを表示・編集の基準にした自動保存
- テキストとカードリンクを一続きで扱う本文エディタ
- 本文中の原子的なリンクカプセル、Backspace削除、Undo / Redo
- displayIdの数値順でカード束をめくる「過去のカード」
- 端末内の全カードと全ての明示的な一方向リンクを俯瞰する「つながり」
- Cloudflare D1を使った冪等同期と、競合内容を両方残す明示的な解決UI
- Service Workerによる初期設定後のオフライン動作
- canonical pathnameとブラウザの戻る／進むに連動するカード・ビュー遷移

Undo / Redoの目的と受け入れ条件は [GitHub Issue #1](https://github.com/fukamu/notes/issues/1) で追跡しています。

## 必要な環境

- Node.js 22.13以降
- npm
- Chromium（E2Eテスト用。`npx playwright install chromium` で導入可能）

## セットアップと起動

```bash
npm install
npm run dev
```

開発サーバーが表示したURLをブラウザで開きます。ローカル実行ではWrangler / Miniflareがプロジェクト内の `.wrangler/` にD1データを保持します。同期APIは最初の要求時に必要なテーブルと採番カウンターを作成します。スキーマのSQLを生成し直す場合は次を実行します。

```bash
npm run db:generate
```

本番ビルド相当で確認する場合は、別々のターミナルで次を実行します。

```bash
npm run build
npm start -- --port 3100
```

ChatGPT Site版は [fukamu-notes-cards.matoruru.chatgpt.site](https://fukamu-notes-cards.matoruru.chatgpt.site) へ配置されています。Cloudflare D1は `DB` というバインディング名で接続します。Siteは初回公開時点では所有者限定で、共有範囲はChatGPT Sites側のアクセス設定で管理します。

## テスト

```bash
npm run format:check
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run build
npm run test:e2e
npm run verify
```

`npm run test:e2e` は本番ビルド相当のローカルサーバーを自動起動し、デスクトップChromeとPixel 7相当のChromiumで検証します。対象はオフライン作成、自動保存、再読み込み、再接続、別端末同期、仮番号から正式番号への変更、重複仮番号と遅延到着、本文リンク、Undo / Redo、一覧、全カードの一方向リンク可視化、現在カードの初期表示、キーボード／タッチ操作、循環・自己リンク・相互リンク、競合保持、deep link、戻る／進むです。

`npm run check` では全runtimeの型検査、静的検査、単体テスト、本番ビルドをまとめて実行します。`npm run verify` はCIと共通の入口で、format check、`check`、Desktop Chrome／Pixel 7相当のE2Eを実行します。型検査のruntime分離、trust boundary、assertion方針、段階的なunsafe lint／codec導入は [型安全の境界と検査](docs/type-safety.md)、データストア・ナビゲーション・描画の依存方向と交換契約は [Application / presentation contracts](docs/application-presentation.md)、認証済みsessionからのVaultContext導出と未認証runtime停止契約は [Identity, session, and VaultContext boundary](docs/session-boundary.md)、Google認証のstate・nonce・PKCE・issuer+subject・明示linking契約は [Google OIDC boundary](docs/google-oidc-boundary.md)、本文editorのheadless操作・Tiptap adapter・renderer・structural DOM契約は [Card editor contracts](docs/card-editor.md)、全UI境界・raw interaction・親 #8 要件1–29の対応は [Presentation boundary audit](docs/presentation-boundary-audit.md) を参照してください。検証はlocal fixture／emulatorのみを使い、本番D1や本番データへ接続しません。

Issue、統合／作業ブランチ、PR、merge後検証、型付き純粋ロジックと副作用adapter、mainへの反映制限は [Issue-based type-safe development workflow](docs/development-workflow.md) を正本とします。実装PRは統合ブランチだけをbaseとし、利用者が対象を特定して明示的に許可するまでmainへ反映しません。

## オフライン条件

初回だけはオンラインでアプリを開き、画面と実行資源をService Workerへ保存してください。以後は通信がなくても、カードの作成・編集・自動保存・リンク・一覧・つながりを、この端末のIndexedDBだけで利用できます。

Service Workerが保存するのは非個人化された `/` のapp shell、manifest、favicon、`/_next/static/` 配下のbuild assetだけです。カードURLのonline response、query付きnavigation、API、認証/OAuth callback、課金・account経路、allowlist外resourceはCacheStorageへ保存しません。offlineのcanonical card/history/connections navigationは、個別responseではなく共通app shellから起動してIndexedDBを読みます。logout cache purgeは対象cacheの消去を再確認したackが返るまで完了扱いにしません。

詳しいcache境界、migration、rollback方針は [`docs/service-worker-cache.md`](docs/service-worker-cache.md) を参照してください。

開発サーバーは差し替え用の仮想モジュールを使うため、オフライン再読み込みの確認には `npm run build` と `npm start -- --port 3100`、または `npm run test:e2e` を使ってください。ブラウザのサイトデータを消すと、その端末の未同期データとオフライン用キャッシュも消えます。

## URLとブラウザ履歴

現在のビューとカード文脈は、次のcanonical pathnameだけから復元できます。

| 状態                           | pathname                     |
| ------------------------------ | ---------------------------- |
| カードがない初期画面           | `/`                          |
| カード編集                     | `/cards/:cardId`             |
| カードを現在位置とする履歴     | `/cards/:cardId/history`     |
| カードを現在位置とするつながり | `/cards/:cardId/connections` |
| カード文脈がない履歴           | `/history`                   |

`:cardId` は小文字のUUIDv7内部IDです。仮番号から正式番号へ変わるdisplayId、query、hash、`history.state`は状態の識別に使いません。対応するdeep linkは直接開いて再読み込みでき、初回同期でカードを取得する間は別カードを表示せず待機します。構文が不正なURL、またはローカル読込と初回同期を終えても解決できないカードは、端末内の末尾カードか `/` へ履歴を増やさず補正します。オフライン時は初回同期の試行を終えた時点のIndexedDBだけで同じ補正を行います。

カード／ビューの選択、新規カード、本文リンク、つながりのカード選択はブラウザ履歴を追加します。同じ移動先の再選択、初期表示、URL補正、戻る／進む、編集、自動保存、同期、displayIdの確定は追加しません。カードがない `/` から最初のカードを作る場合だけは現在の履歴項目を置換し、既存カードからの新規作成は元の画面へ戻れる履歴を残します。

一度オンラインでService Workerの準備を完了した同じ端末では、deep linkのままオフライン再読み込みできます。初回アクセスから完全にオフラインの新しい端末は対象外です。

## 自動保存と同期

保存ボタンはありません。新しいカードはタイトルも本文も空のまま有効で、作成直後から端末へ保存されます。タイトル、本文、リンク、Undo / Redoによる変更はIndexedDBへ順番に保存され、未送信変更はカードごとに最新状態へまとめられます。画面には「保存中」「保存済み」「同期中」「オフライン・端末に保存済み」「同期失敗・端末に保存済み」を表示します。

オンライン時は起動時、編集後、再接続時、および15秒間隔で同期します。同じ `mutationId` の再送は同期先で一度だけ適用されます。送信中に新しい編集が保存された場合は、応答後に新しい編集を再送するため、古い応答で本文を巻き戻しません。

同じカードを複数端末で編集し、基準リビジョンが一致しない場合は、一方を黙って上書きしません。端末側と同期先側のタイトル・本文を競合レコードとして両方表示し、利用者が残す方を選びます。これはリアルタイム共同編集ではありません。

## displayIdの採番規則

端末はオフライン作成時に、端末内で使われている最大の正式番号・仮番号より大きな仮番号を割り当てます。仮番号はIndexedDBに残るため再読み込み後も維持されます。別端末同士で仮番号が重複しても構いません。

新しいカードを同期先が初めて受理すると、D1の単一カウンターをカード作成と同じバッチ内で進め、単調増加する正の整数を正式番号として確定します。同時に受理したカードはUUIDv7で安定して並べてから採番します。再送しても同じカードや番号を増やしません。

確定済みの正式番号は変更・再利用しません。古いカードが後から届いても、その時点の次番号になります。端末内の仮番号と他端末から届いた正式番号が衝突した場合は、正式番号を維持し、未確定カードだけを作成順のまま未使用番号へ振り直します。採番前後で内部IDは変わらないため、本文中のリンク先も変わりません。

## 本文とリンクの構造

本文は文字列へ埋め込んだ記法ではなく、順序付きのセグメントとして保存します。

```ts
type BodySegment =
  { type: 'text'; text: string } | { type: 'link'; targetCardId: string };
```

空白、改行、リンク前後の順序はテキストセグメントに保持されます。リンクが保存するのは対象カードのUUIDv7内部IDだけです。displayIdやタイトルが変わるとカプセル表示は更新されますが、参照は切れません。

半角 `#` を単語境界で直接入力すると候補を開きますが、利用者が候補を選ぶまではリンクになりません。`C#`、手入力した `#123`、全角 `＃`、貼り付けた文字列、URL、Markdown風文字列は自動変換しません。本文はプレーンテキストとカードリンクだけを扱い、装飾、Markdown、自動URLリンクはありません。

保持する関係は本文に書かれた `A → B` だけです。「つながり」は端末内の全カード（孤立カードと非連結コンポーネントを含む）を表示し、全カードの本文から、存在するリンク先への明示的な一方向リンクを都度列挙します。同じ有向ペアが本文に複数あっても表示上は1辺へ集約し、欠損したリンク先は無視します。現在カードは強調表示と初期表示位置にだけ使い、表示対象の絞り込みには使いません。逆向きの関係、被リンク件数、被リンク用のAPI・型・保存データはありません。

配置にはアプリへバンドルした `elkjs` のELK Layered（Sugiyama系）を使います。方向は左から右、edge routingは `ORTHOGONAL` とし、greedy cycle breaking、layer sweep crossing minimization、network simplexの層割当／ノード配置、コンポーネント・ノード・辺の間隔を設定しています。各辺専用の東西ポートを与え、ELKが返したnode-safeなedge section、bend point、ポート端点は維持したまま、実SVG quadratic curveで各cornerだけを安全な半径へ丸めます。endpoint直線tangent、背景色halo、矢印により、交差が残る場合も経路と方向を追えるようにしています。配置計算は端末内で完結し、CDNやネットワークへ依存しません。

## 既知の制約

- 1人・1コレクション専用で、公開登録、権限管理、複数ユーザー分離はありません。
- 初回のアプリ資源取得には通信が必要です。
- UUIDv7は端末時計が正確である前提です。時計ずれ補正は行いません。
- 同期先は本文を読めます。エンドツーエンド暗号化はありません。
- 競合は自動マージせず、双方を保持して利用者へ選択を求めます。
- 旧版とのデータ、API、DB、仕様の互換性・移行機能はありません。
- 画像、添付、検索、タグ、推薦、AI整理、リアルタイム共同編集は対象外です。
- 大量カード向けの高度な一覧仮想化やグラフ集約は行いません。
- 任意の有向グラフでは交差を常にゼロにできません。ELKで不要な交差と重なりを減らし、残る交差はhaloで判別しやすくしますが、密グラフでは線が多くなります。
