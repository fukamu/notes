# つながりカードwindowingと俯瞰Canvas（Issue #325）

## 結論

Issue #325は、当時の全件グラフ・全方向付き参照・検索可能なnative一覧を維持したまま、
10,000枚のカードbuttonを常時mountする方式を撤廃した。通常倍率ではcameraの可視範囲と
96px overscanに交差するカード、およびfocusを保持する1枚だけをHTML buttonとして描画する。
画面上のカード高さが36px未満になる俯瞰倍率では、可視カードを個別の角丸矩形として
viewportサイズのCanvasへ描画し、HTML cardはfocus保持中の1枚を除いてmountしない。

これは表示件数上限ではない。全10,000 node・19,999 directed edgeはsemantic model、
layout geometry、BVHと、Issue #325時点のnative一覧に残る。Canvasは`aria-hidden`であり、
全件へのkeyboard・支援技術上の入口は検索・page付きnative一覧が担っていた。

Issue #329の後続仕様では、この一覧と専用操作を削除した。通常倍率HTML card windowing、
overview Canvas、全件graph/layoutは継続するが、一覧と同等の全件列挙経路は提供しない。

## 実装境界

- `connections-visibility.ts`は既存node BVHへ正確なhit boundsを保持し、HTML/overviewの
  閾値判定と反復的なpoint hit testを純粋関数として提供する。
- 通常倍率は可視node indexだけを元の入力順でHTML化する。focus中のcardはoverscan外でも
  保持する。Issue #325時点では一覧の「マップ移動」も既存cameraを可読倍率へ移していた。
- 俯瞰Canvasは可視nodeをまとめて一つのクラスタへ置換せず、各カードを別のsubpathとして描く。
  現在カードはprimary色で区別する。Canvas clickは同じBVHを逆camera変換して元cardを開く。
- edge Canvasとcard Canvasは同じrAF camera snapshotを使う。pan・zoomでlayout、曲線化、
  Path2D準備を再実行しない。HTMLとCanvasでcamera transformを二重適用しない。
- layout失敗時も全カードをDOMへ戻さず、上部のnative semantic一覧から検索して開ける。
- semantic card rowにfocus中のcardが同期で削除された場合は、同じpage位置の次のrow、
  pageが空なら検索欄へfocusを回復する。削除されていない場合のfocusは変更しない。

## 製品経路の確認

同一の10,000 node / 19,999 edge fixtureを製品Worker manager、React画面、Canvas renderer経由で
Chromium 153.0.8010.12に通した。desktopは1280×720/DPR 1、mobileは412×839/DPR 2.625の
emulationで、CPU throttleは使用していない。値は共有hostの探索的な単回sampleであり、
統計的SLOやCIのwall-clock閾値ではない。生値は
[`connections-card-windowing.json`](benchmarks/connections-card-windowing.json)に保存した。

| project          | 初回ready |      通常倍率graph DOM |      全体fit graph DOM | card Canvas全体fit | 全体fit連続frame p95 |
| ---------------- | --------: | ---------------------: | ---------------------: | -----------------: | -------------------: |
| desktop Chromium |  約3.48秒 | descendants 7 / card 1 | descendants 3 / card 0 |            約4.5ms |            約183.4ms |
| mobile emulation |  約2.54秒 | descendants 7 / card 1 | descendants 3 / card 0 |            約3.7ms |            約216.7ms |

初回5秒の目安を両projectで満たし、代表gesture scenarioのframe p95は約16.7〜16.8ms、
long taskは0だった。一方、10k全体fitで30frame連続panした場合は50ms目安を満たさない。
このときedge draw p95はdesktop約90.5ms、mobile約105.5msで、card Canvasは約4.0/3.7msだった。
したがって残る支配要因は全体fitで毎frame全辺を再描画する経路であり、HTML card commitや
overview card Canvasではない。

`layoutReadyMs`はnavigation開始からlayout ready属性までの製品wall timeで、replica取得、
projection、Worker、decode、React commitを含む。ELK/corridor内部だけの時間として扱わない。
heap値もGC依存の観測値であり、desktop/mobile比較や上限保証には使わない。

## 判断

- 完全membership、native semantic access、通常倍率HTML card、俯瞰card hit test、
  初回5秒目安は受入可能。
- 全体fit連続操作の50ms目安は未達。実測で指定条件を満たしたため、次の独立Issueで
  viewport＋overscanの描画bitmap再利用を評価する。
- 次段階は巨大world bitmapやtile cacheを作らず、layout/mode/theme/DPRで無効化される
  boundedなfront/back surfaceを使う。panは既存bitmapを移動し、zoom中は一時scale、停止後に
  正確な再描画を行う。これで不足するときだけOffscreenCanvas Workerを検討する。
- graph aggregation、node/edge削除、WebGL、カード全体Canvas化、Sites/deployment、main変更は
  このIssueに含めない。
