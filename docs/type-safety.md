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

## trust boundary

| 境界                             | 現在の検査                                                            | 担当Phase     |
| -------------------------------- | --------------------------------------------------------------------- | ------------- |
| Service Worker `message.data`    | object、message type、URL配列、string、same-origin、内部/API path除外 | Phase 1 (#10) |
| DOM event target                 | `Element` のruntime guard後にcard-link属性を読む                      | Phase 1 (#10) |
| Tiptap card-link attrs           | object、string、UUIDv7を小さなadapterで検査                           | Phase 1 (#10) |
| 合成互換fixture                  | 現行のcard/body/mutation/conflict/sync形と固定UUIDv7                  | Phase 1 (#10) |
| networkのsync request / response | Phase 1の既存guardを維持し、codecを追加                               | Phase 2 (#11) |
| IndexedDB record                 | 現行形式を維持し、読出しcodecを追加                                   | Phase 2 (#11) |
| D1 row / JSON column             | 現行形式を維持し、row codecを追加                                     | Phase 3 (#12) |

Phase 1では、未修正のnetwork、IndexedDB、D1境界に対するunsafe lintを形だけ無効化していません。全面的なunsafe rule set、残るcodec、APIとD1のatomicityはPhase 2/3で完成させます。

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
