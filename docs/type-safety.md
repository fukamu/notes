# 型安全の境界と検査

FUKAMU Notesは、コンパイル時の型と外部入力の実行時検証を別の責務として扱います。この文書は #9 の3段階の作業で維持する基準です。

## コンパイラ設定

`tsconfig.base.json` は `strict` に加えて次を全runtimeへ適用します。

- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `noImplicitReturns`
- `noFallthroughCasesInSwitch`
- `noImplicitOverride`

global typeの混在を避けるため、`npm run typecheck` は次の独立したentryを実行します。

| 設定                           | 対象runtime                       | 主な対象                                       |
| ------------------------------ | --------------------------------- | ---------------------------------------------- |
| `tsconfig.json`                | browser / React                   | `app`（API以外）、`components`、`hooks`、`lib` |
| `tsconfig.api.json`            | Cloudflare Worker / D1            | `app/api`、`db`、domain、sync protocol         |
| `tsconfig.service-worker.json` | Service Worker                    | `public/sw.js`（`checkJs`）                    |
| `tsconfig.tooling.json`        | Node.js                           | Vite、Vitest、Playwright、Drizzle等の設定      |
| `tsconfig.test.json`           | Node.js + 明示したbrowser fixture | unit / integration / E2E test                  |

`skipLibCheck: true` は、Vite、Cloudflare、Reactなど複数の第三者宣言の検査に限定して残しています。上記すべてのentryでアプリの `.ts`、`.tsx` と対象の `.js` は通常どおり検査されるため、自コードの検査を除外する設定ではありません。

## assertionとinvariant

外部値を `as` だけで信頼してapplicationやdomainへ渡しません。原則は次の順です。

1. 入力を `unknown` として受ける。
2. `typeof`、`Array.isArray`、`instanceof Element`、値域検査などで絞り込む。
3. 検証済みの値だけを型付きの内部APIへ渡す。

第三者宣言の不足を補う最小のassertion、literalを保つ `as const`、契約を検査する `satisfies` は許容します。assertionを使う場合は直前のruntime guard、必要理由、境界testを置きます。double assertion、`@ts-ignore`、`@ts-expect-error`、広いlint disableは使用しません。

内部で「構築処理が必ず作った値」をMapや配列から再取得するときは、`lib/shared/invariant.ts` で明示的に失敗させます。non-null assertionで欠損を隠しません。

## 共通codecと識別子

`lib/codec/core.ts` のdecoder combinatorがruntime schemaの正本です。`objectDecoder`、`arrayDecoder`、`unionDecoder`等から出力型を `InferDecoder` で推論するため、型とvalidatorを別々に手書きしません。失敗は値そのものを含めず、field pathと理由だけを `BoundaryDecodeError` に保持します。利用者向けには既存の安全な保存／同期失敗文言だけを表示します。

外部contract objectは未知fieldを拒否します。Tiptap attributesだけは第三者adapterの拡張fieldを捨てる目的で未知fieldを許可し、検証済みの `targetCardId` だけを取り出します。文字列、配列、同期件数には `CONTRACT_LIMITS` の上限を適用します。ID、revision、display ID、timestampは次を共通policyとします。

- IDはUUIDv7だけを受理する。
- revisionとdisplay IDは1以上のsafe integerにする。
- timestampは0以上のsafe integerにする。
- `NaN`、無限値、小数、safe integer範囲外を拒否する。
- card、mutation、conflict、正式display ID、acknowledgementの重複を拒否する。
- sync response内のcard／conflict参照と、送信していないmutationへのackを拒否する。

`CardId`、`MutationId`、`ConflictId`、`DeviceId` は別々のopaque brandです。UUID生成関数または対応するparse／decoderだけがbrandを付けます。`PendingMutation` は `kind` で絞り込めるunionで、`upsert` の `conflictIds` は空tuple、`resolve` は重複のないnon-empty tupleです。分岐の終端には `assertNever` を置き、variant追加をcompile errorにします。

## wire／storage／domain mapping

domain objectをnetworkまたはIndexedDBへ渡すときは、`encodeSyncRequest` と `encodeStored*` がplain DTOへ写します。受信時は `decodeSyncResponse` と `decodeStored*` が `unknown` から全fieldを検証してbrandを復元します。wire DTOとIndexedDB recordをdomain modelのaliasとして扱いません。保存するJSON／IndexedDB objectのfield名と値はv1から変更せず、database versionも1のままです。

同期responseは、全field、重複、参照、ack subsetを検証し終えてからreadwrite transactionを開きます。適用中に例外が起きた場合はtransactionを明示的にabortするため、card put、pending mutation delete、conflict clearの一部だけがcommitされません。不正な2xx responseは同期失敗となり、未送信mutationと画面上の最新編集を保持して同じretry操作から再送できます。

IndexedDBの `get()`／`getAll()` はadapter内でも `unknown` として扱います。壊れたcards、mutations、conflicts、metaを見つけた場合は初期化／同期を失敗させ、raw recordを自動削除・上書きしません。UIは「端末への保存に失敗」または「同期失敗・端末に保存済み」を表示します。device IDを自動生成するのはmeta recordが存在しない場合だけで、存在する不正recordは保持して診断対象にします。自動修復やmigrationは行いません。

## trust boundary

| 境界                          | 現在の検査                                                            | 担当Phase     |
| ----------------------------- | --------------------------------------------------------------------- | ------------- |
| Service Worker `message.data` | object、message type、URL配列、string、same-origin、内部/API path除外 | Phase 1 (#10) |
| DOM event target              | `Element` のruntime guard後にcard-link属性を読む                      | Phase 1 (#10) |
| Tiptap card-link attrs        | object、string、UUIDv7を小さなadapterで検査                           | Phase 1 (#10) |
| 合成互換fixture               | 現行のcard/body/mutation/conflict/sync形と固定UUIDv7                  | Phase 1 (#10) |
| networkのsync response        | 全体codec、重複／参照／ack subset、transaction前検証                  | Phase 2 (#11) |
| IndexedDB record              | 全storeをunknownからdecodeし、明示encodeでv1形式を維持                | Phase 2 (#11) |
| APIのsync request             | 共通codecは定義済み。HTTP境界での最終適用とerror分類を完成            | Phase 3 (#12) |
| D1 row / JSON column          | 現行形式を維持し、row codecを追加                                     | Phase 3 (#12) |

Phase 2ではclient response／IndexedDBを完成させました。D1 row、`body_json`、environment binding、API requestの最終適用、D1 transactionの意味、unsafe rule全面強制はPhase 3で完成させます。

## 第三者adapterの追加チェックリスト

- 境界の入力型は `unknown` または第三者が実際に保証する最小型か。
- object、配列、必須field、discriminant、数値範囲、ID形式を実行時に検査したか。
- optional fieldを `undefined` のまま必須fieldへ格上げしていないか。
- DOM nodeは `Element` 等のguard後に使用しているか。
- assertionがある場合、直前のguardと理由があり、範囲が最小か。
- malformed値、欠損値、正しい値を境界testで確認したか。
- adapterからapplication/domainへ渡す型に第三者固有の曖昧さが漏れていないか。

## 共通の検証入口

`npm run verify` がlocalとCIの共通入口です。format check、全runtime typecheck、lint、unit/integration test、production build、Desktop ChromeとPixel 7相当のE2Eを順に実行します。production build後は `dist/client/sw.js` が存在し、型検査済みのmessage guardを含むことも検査します。CIとtestはlocalのfixture / emulatorだけを使い、本番D1、本番データ、デプロイを使用しません。
