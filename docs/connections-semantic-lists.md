# つながり全件semantic一覧（Issue #323）

> **後続仕様:** Issue #329 は、この一覧・専用検索・ページ操作・一覧からの移動を製品UIから削除した。以下はIssue #323時点の性能判断履歴であり、現行UIの説明ではない。全件graph/layoutとCanvas描画は維持するが、同等の全件列挙DOMは追加しない。

## 結論

PR #322統合後の10k製品画面では、全19,999参照を読み上げ用`li`として常駐させていた。Issue #323では、見えるnative HTML操作「カードと参照の一覧」へ置換した。閉じている間は一覧内容をmountせず、開いた場合もカードと方向付き参照を独立して検索・50件ずつpage表示する。

全10,000 node・19,999 directed edgeはsemantic modelとlayout geometryに残る。検索、page、一覧のopen/closeはlayout key、Worker要求、cameraを変更しない。カードの「マップ移動」だけが既存cameraを可読倍率へ移し、対象HTML cardへfocusする。

## 実装境界

- `lib/graph/connections-semantic-list.ts`は、card IDに依存しない検索用projection、NFKC/lowercaseによるquery正規化、AND検索、page clamp、rangeを純粋関数として提供する。
- `components/connections-semantic-lists.tsx`はnative `details`、`ol`、`button`、`input`を使う。`role=application`、独自grid/listboxは使わない。
- card検索は表示番号とtitle、edge検索はsource/target双方の表示番号とtitleを対象とする。edge rowはsource → targetを示し、両端を別々に開ける。
- 閉じる操作はsummaryへfocusを戻す。検索入力とpage controlはstableなDOMに残るため、入力・page変更後のfocusを維持する。
- 旧sr-only全edge listは撤去した。CSSで隠すだけの全件DOMは残していない。

## 検証

- pure unit: 127件を3pageで欠落・重複なく走査、最終page、0件、無効page clamp、card/edge検索。
- small product E2E: desktop/mobileでself link、mutual links、cycle、別component、isolated card、検索focus、close focus return。
- 10k product E2E: card 200page、edge 400page、各最大50件、最終page直接到達、任意card検索とmap focus、closed items 0、完全graph/Canvas維持。

同一の10k fixtureによる単回の参考値は `docs/benchmarks/connections-semantic-lists.json` に保存した。

| project                   |  initial ready | closed list items | localized descendants | whole-world descendants |
| ------------------------- | -------------: | ----------------: | --------------------: | ----------------------: |
| Chromium desktop          | 約6.49〜8.66秒 |                 0 |                10,005 |                  30,003 |
| Mobile Chromium emulation | 約6.65〜8.37秒 |                 0 |                10,005 |                  30,003 |

直前のCanvas辺段階はlocalized 30,005 / whole-world 50,003 descendantsであり、常駐semantic edge 19,999件の撤去効果を確認した。一方、2回のsampleでdesktop初回約6.49〜8.66秒、mobile初回約6.65〜8.37秒となり、whole-worldの10,000 card shell/contentが残る。5秒・full-fit操作予算はまだ満たさない。このIssueを全体性能達成とは扱わず、通常倍率のHTML card windowingとoverview Canvas card shapesを次Issueで行う。

main、Sites、deployment、production dataは変更しない。
