# つながりマップの自由パン（Issue #330）

## 結論

Issue #330は、有限なworld boundsと24pxのfit余白を維持したまま、cameraの
`x` / `y`をworld boundsへ拘束しない仕様へ変更した。world boundsは全体表示と可視判定の
入力であり、camera位置の境界ではない。倍率の動的下限・上限、保存倍率、zoom/pinchの
anchor、resize時の中心、全体表示、現在カードへの復帰は維持する。

`clampConnectionsCamera`はgeometryと有限値を検証し、scaleだけを制限する。自由パン用の
dummy world、Infinity、巨大scroll要素は導入していない。pan・zoom・pinch・resize・layout
anchor保持は同じcamera validationを通るため、空領域へ移動した後の別操作でも配置範囲へ
強制帰還しない。

## 製品経路の確認

Chromium 153.0.8010.12、desktop 1280×720 / DPR 1、mobile 412×839 / DPR 2.625、
CPU throttleなしで、10,000 node / 19,999 directed edgeの同じ製品fixtureを単回実行した。
mobileはPlaywright emulationで実機CPU保証ではない。共有hostの探索的sampleであり、
統計的SLOではない。

| project          | 初回ready | 通常gesture p95 | 64px往復pan p95 |              往復cache | 512px一方向pan p95 | cold edge/card p95 |      refresh |
| ---------------- | --------: | --------------: | --------------: | ---------------------: | -----------------: | -----------------: | -----------: |
| desktop Chromium |  約2.52秒 |          16.8ms |          33.4ms | 各30 reuse / 0 refresh |            133.3ms |       73.1 / 4.2ms | edge/card各4 |
| mobile emulation |  約2.54秒 |          16.7ms |          33.4ms | 各30 reuse / 0 refresh |            133.4ms |       86.5 / 1.6ms | edge/card各4 |

往復計測はcameraの最大移動64px、異なるcamera位置2つ、終了時の原点差0pxを同時に検査する。
したがって、eventだけを処理してcameraが動かなかった値ではない。96px overscanを越える
一方向計測はcameraを512px移動し、正常なbounded bitmap refreshを4回発生させた。refresh後も
edge/card bitmap寸法はdesktop 1202×674px、mobile 1496×1777pxのままで、移動距離に応じた
bitmap拡大やcache枚数増加はない。

連続cache reuseは既存の50ms目安を満たす。一方、同期cold rasterを伴うframeは同目安を
超える。この値は従来から別記しているcold処理であり、cache-hitの操作値へ混ぜない。
今回の目的は自由パンとbounded refreshの正しさであり、この単回sampleだけを理由に新しい
Worker、tile cache、world bitmapまたはWebGLを追加しない。

## 以前の記録との関係

Issue #327の全体fit keyboard panは、当時のtranslation clampによりfit位置からcameraが
移動しなかった可能性がある。保存済み値はbounded renderer導入時の歴史記録として残すが、
自由パンの性能証拠には使わない。Issue #330のE2Eは途中camera位置も検査し、cache内往復と
overscan越えのrefreshを分けて記録する。

unitは大きいworldと小さいworldの四方向越境、画面外でのzoom/pinch/resize anchor、明示的な
fit/current復帰、scale clamp、非有限値拒否を確認する。desktop/mobile E2Eはkeyboard、drag、
一本指、pinch、修飾wheel、pointer capture、click抑制、全件geometryとbounded cacheを維持する。

`main`、Sites、deployment、production dataは変更しない。
