# つながりbounded bitmap再利用（Issue #327）

## 結論

Issue #327は、10,000 node / 19,999 directed edgeの全体fitで、同じ全辺と全カードを
camera更新ごとにCanvasへ再描画していた経路を、viewport＋96px overscanの描画済みbitmap
再利用へ変更した。全件グラフ、corridor配置、曲線、辺ごとのhalo→stroke→arrow、入力辺順、
card形状、検索可能なnative一覧は変更していない。

製品経路の2回の記録では、30 frameの全体fit連続panのp95はdesktop 33.3–33.4ms、
mobile Chromium emulation 33.4msだった。Issue #325で記録した約183/217msから低下し、
50ms目安を両projectで満たした。各runの30回はedge/cardともcache refresh 0、reuse 30で、
cached bitmapの転送はp95 0.0–0.1ms、long taskは0だった。初回readyも約2.30–2.42秒で
5秒目安を維持し、通常倍率の既存gestureは両projectでframe p95 16.7msだった。

この実測で許可された第一段階が目標を満たしたため、条件付きのOffscreenCanvas Workerは
実装していない。

## 実装境界

- 純粋coreはcapture camera、viewport、overscanと現在cameraから、bitmapの移動・拡縮先と
  coverageを計算する。DOM、Canvas、clockを参照しない。
- browser adapterはfrontとbackの最大2面だけを所有する。各面は
  `(viewport + 2 × 96px overscan) × DPR`で、約80k×120kのworld canvasやtile cacheではない。
- geometry、色、DPR、viewport、overscan、描画modeまたは選択強調revisionが一致し、
  capture範囲が現在viewportを覆う場合だけ既存bitmapを使う。境界を越えた場合は現在の
  全対象をbackへ同期描画してから交換するため、未描画領域を表示しない。描画失敗時は
  同じframeで既存の直接Canvas描画へfallbackする。
- overview zoom中は既存bitmapの一時拡縮を許し、最後のscaled frameから120ms後に現在倍率・
  現在DPRで正確に再描画する。通常倍率は少数要素の直接描画を維持する。
- layout/theme/mode/DPRの変更はrevisionまたはcache互換条件で再描画する。HTML modeへの復帰、
  unmount、scope/logoutに伴うrenderer resetではfront/backの幅・高さを0にして参照を破棄する。
- edgeとcardは同じrAF camera snapshotを使う。bitmap差分はdestination Canvas内だけで適用し、
  HTML world transformを二重に適用しない。

全体fit keyboard panでは、以前はevent処理時とrAF描画時に同じ可視BVH queryを2回行っていた。
pointer panと同じくrAF側の1回へ統一した。96px overscan内の64px keyboard panでは、Reactの
可視集合更新前にもcapture bitmapが現在viewportを覆うため、空白を作らない。

## 製品経路の記録

Chromium 153.0.8010.12、desktop 1280×720/DPR 1、mobile 412×839/DPR 2.625、
CPU throttleなしで、同じ製品Worker manager・React・Canvas経路を2回実行した。mobileは
PlaywrightのPixel 7 emulationで、実機CPU保証ではない。値は共有hostの少数sampleであり、
統計的SLOではない。生値は
[`connections-bounded-raster-cache.json`](benchmarks/connections-bounded-raster-cache.json)に保存した。

| project          |   初回ready | cold edge raster |   全体fit切替 | 連続pan frame p95 |        edge/card cache | long task |
| ---------------- | ----------: | ---------------: | ------------: | ----------------: | ---------------------: | --------: |
| desktop Chromium | 2.30–2.32秒 |      76.6–79.4ms | 254.7–256.4ms |       33.3–33.4ms | 各30 reuse / 0 refresh |         0 |
| mobile emulation | 2.39–2.42秒 |    100.7–111.2ms | 280.4–286.1ms |            33.4ms | 各30 reuse / 0 refresh |         0 |

`initialReadyMs`と全体fit切替はnavigation/UI操作から検査完了までのwall timeであり、
純粋なlayoutまたはraster時間ではない。cold edge rasterは全19,999辺の描画を含み、
desktop約94–96ms、mobile約134–139msの全体fit切替時Canvas drawも隠していない。
50msはcold処理ではなく、指定どおり連続操作のframe指標へ適用した。

bounded面はgraph viewportに対しdesktop 1202×674px、mobile 1496×1777pxで、edge/cardとも
同じ上限だった。保持量をworld寸法に比例させず、2面を越えて増やさない。ブラウザーheapは
GC依存のためbitmap byte数の保証には使っていない。

## 確認範囲と残る限界

unitではcoverage、pan移動、zoom拡縮、正確なforce refresh、revision invalidation、2面上限、
reset解放、refresh失敗時の直接描画fallbackを確認した。renderer testはPath2D再生成なしでの
reuseと、辺のhalo→stroke→arrow順を維持する。製品E2Eは全10,000 node・19,999 edge、
bounded pixel寸法、30/30 reuse、全件native一覧、通常倍率HTML windowingを同時に確認する。

通常倍率のcard/edge品質、方向、曲線、hit test、keyboard/touchは既存検査を維持する。
利用可能な専用screen reader実機はこの環境になく、native controlとChromium accessibility tree、
keyboard E2Eで確認した範囲を証拠とする。

cache miss時のcold rasterはdesktop約100ms、mobile約155msのedge drawを要する場合がある。
これはfit切替の待ち時間として記録し、連続reuse値に混ぜていない。今回の完了条件は満たすため、
Worker、world bitmap、tile cache、WebGL、graph集約は追加しない。`main`、Sites、deployment、
production dataは変更していない。

## Issue #330による後続の解釈

Issue #327時点の全体fit keyboard panは、translation clampによってfit位置からcameraが
動かなかった可能性がある。その値は導入時の歴史記録として残すが、自由パンの証拠には
使わない。Issue #330はcameraの途中位置を検査し、実際の64px往復で同じ33.4ms p95と
各30 reuse / 0 refreshを確認した。さらに512px一方向移動ではbounded面を拡大せず、
edge/card各4回の正常なrefreshを記録した。後続の条件と値は
[`connections-free-pan.md`](connections-free-pan.md)を参照する。
