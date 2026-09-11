# 親 #9 要件1–30の統合監査

この表は #10、#11、#12 の統合状態を、親 #9 の分割前要件へ対応付けた証跡です。子PR統合後にも同じ検査を再実行し、親Issueは最終PRが `main` へ反映されるまでopenに保ちます。

| 要件 | 実装／証跡                                                      | 担当      |
| ---- | --------------------------------------------------------------- | --------- |
| 1    | `tsconfig.base.json` のstrict追加optionと設定test               | #10       |
| 2    | app／API／Service Worker／tooling／test別typecheck              | #10       |
| 3    | 型付きService Worker正本、生成asset、message境界test            | #10／#12  |
| 4    | `skipLibCheck` を第三者宣言だけに限定する方針を文書化           | #10       |
| 5    | unsafe assignment／argument／call／member／returnをerror        | #12       |
| 6    | non-null、不要assertion、double cast、ts-comment／disable禁止   | #10／#12  |
| 7    | 第三者adapterのguard・最小assertion・境界test監査               | #10／#12  |
| 8    | `lib/codec/core.ts` を共通runtime schema基盤に設定              | #11       |
| 9    | Body、record、mutation、sync、storage、adapter、D1 rowをcodec化 | #11／#12  |
| 10   | dependency-free decoder combinatorを採用し型を推論              | #11       |
| 11   | raw値を含まないpath／reason診断                                 | #11       |
| 12   | Card／Mutation／Conflict／Device UUIDv7 brand                   | #11       |
| 13   | safe integer、正数、timestamp、文字列／配列／payload上限        | #11／#12  |
| 14   | upsert／resolve判別共用体とconflict tuple invariant             | #11／#12  |
| 15   | domain／wire／IndexedDB／D1の明示mapping                        | #11／#12  |
| 16   | `assertNever` とswitch exhaustiveness rule                      | #11／#12  |
| 17   | network、storage、D1、environment、SW、DOM／Tiptapをunknown検証 | 全子Issue |
| 18   | SyncResponseの全field・重複・参照検証                           | #11       |
| 19   | acknowledgementを送信mutationの重複なしsubsetに制約             | #11       |
| 20   | response全検証後の単一IndexedDB transactionとabort test         | #11       |
| 21   | 不正IndexedDB値を保持し自動修復／上書きしない                   | #11       |
| 22   | SyncRequest root decode、malformed／limitの400／413分類         | #12       |
| 23   | UUID、数値、timestamp順、body、重複、unknown、kind invariant    | #11／#12  |
| 24   | invalid request前後のMiniflare D1 snapshot不変test              | #12       |
| 25   | resolveの所属・存在・revision条件とatomic rollback／race test   | #12       |
| 26   | D1 row／body JSON codecとschema drift test                      | #12       |
| 27   | DB binding／site URL runtime検証と設定drift検査                 | #12       |
| 28   | `npm run verify` をPR／integration push CIで強制                | #10／#12  |
| 29   | trust boundary architecture testでunchecked cast再導入を防止    | #12       |
| 30   | Miniflare／fixtureのみ使用し、本番資源・deployを不使用          | 全子Issue |

## 維持確認

- #10のstrict設定、runtime分割、CI、Service Worker成果物検査を削除・緩和していない。
- #11のcodec、brand、wire／storage mapping、ack／参照検証、IndexedDB atomicity testを削除・緩和していない。
- 有効なcompatibility fixtureのwire／storage round-tripと既存同期shapeを維持する。
- UI、layout、文言、#8、#6、#7の機能は変更対象に含めない。

## 実行入口

`git diff --check`、`npm run format:check`、`npm run check`、`npm run test:integration`、`npm run test:architecture`、`npm run test:e2e` を子PRと統合後に実行します。失敗、skip、未実行は成功として扱いません。
