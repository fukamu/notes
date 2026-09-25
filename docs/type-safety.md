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

| 設定                           | 対象runtime                       | 主な対象                                         |
| ------------------------------ | --------------------------------- | ------------------------------------------------ |
| `tsconfig.json`                | browser / React                   | `app`（API以外）、`components`、`hooks`、`lib`   |
| `tsconfig.api.json`            | legacy API compatibility          | `app/api`、`db`、`server`、domain、sync protocol |
| `tsconfig.service-worker.json` | Service Worker                    | `public/sw.js`（`checkJs`）                      |
| `tsconfig.tooling.json`        | Node.js                           | Vite、Vitest、Playwright、Drizzle等の設定        |
| `tsconfig.test.json`           | Node.js + 明示したbrowser fixture | unit / integration / E2E test                    |

`skipLibCheck: true` は、Vite、Cloudflare、Reactなど複数の第三者宣言の検査に限定して残しています。上記すべてのentryでアプリの `.ts`、`.tsx` と対象の `.js` は通常どおり検査されるため、自コードの検査を除外する設定ではありません。

Oxlintはapp、API／D1／server、Service Worker、tooling、testの全対象でunsafe assignment／argument／call／member access／return、不要なassertion、non-null assertion、switch exhaustivenessをerrorにします。baseline、対象の広い除外、blanket disableはありません。`server/core` は既存のdomain/application/syncと同じpure-core architecture検査とcoverage対象に含め、将来のprovider adapterから逆依存させません。Service Workerは `service-worker/sw.ts` を型付き正本とし、build時に静的asset `public/sw.js` を生成してproduction成果物も検査します。

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

domain objectをnetworkまたはIndexedDBへ渡すときは、`encodeSyncRequest` と `encodeStored*` がplain DTOへ写します。受信時は `decodeSyncResponse` と `decodeStored*` が `unknown` から全fieldを検証してbrandを復元します。wire DTOとIndexedDB recordをdomain modelのaliasとして扱いません。Sync v2のmutation draftはversioned wrapperへ保存し、旧flat recordはdecoderで保守的なoriginへ移すため、既存offline dataを破壊的にmigrationしません。

同期responseは、全field、重複、参照、ack subsetを検証し終えてからreadwrite transactionを開きます。適用中に例外が起きた場合はtransactionを明示的にabortするため、card put、pending mutation delete、conflict clearの一部だけがcommitされません。不正な2xx responseは同期失敗となり、未送信mutationと画面上の最新編集を保持して同じretry操作から再送できます。

IndexedDBの `get()`／`getAll()` はadapter内でも `unknown` として扱います。壊れたcards、mutations、conflicts、metaを見つけた場合は初期化／同期を失敗させ、raw recordを自動削除・上書きしません。UIは「端末への保存に失敗」または「同期失敗・端末に保存済み」を表示します。device IDを自動生成するのはmeta recordが存在しない場合だけで、存在する不正recordは保持して診断対象にします。自動修復やmigrationは行いません。

## API／D1境界とatomicity

同期APIはpayload byte上限を確認し、`Request.json()` の結果を `unknown` のまま共通 `SyncRequest` codecへ渡します。malformed JSON、root型、field、UUIDv7、safe integer、timestamp順序、本文、件数、重複、unknown field、mutation kind別invariantの違反は400、payload超過は413です。request pathではschema DDLを実行せず、未migration環境はfail closedにします。内部障害は500とし、responseとlogにはraw request／rowを含めません。

D1の `.first()`／`.all()` はgeneric指定をruntime保証にせず `unknown` として受け、row codecでID、display ID、revision、timestamp、nullable性、文字列を検査します。`body_json` はparse結果を `unknown` とし、共通Body codecを通します。rowからmappingしたserver outputは最後に `SyncResponse` codecで重複と参照を含めて再検証してから200 responseにします。

`resolve` は非空・重複なしのconflict IDに加え、全IDが対象cardに属することとbase revisionを、card updateのSQL条件内で確認します。update、対象conflict削除、mutation log挿入は単一D1 batchです。条件不成立時は後続statementもguardされて無変更になり、batch末尾で失敗した場合はD1 transactionが全statementをrollbackします。このため確認後race、別card／存在しない／一部だけ正しいID、stale revisionで上書きできません。

## schemaとenvironment

Drizzle schema、checked-in migration、feature-owned manifestはschema testがtable、column、CHECK、foreign key、unique／indexとchecksumを照合します。migration ledgerの未知ID、非prefix履歴、checksum不一致はschema driftとして適用前に拒否します。D1 effectは明示runnerに限定し、各migrationのDDLとledger insertを単一batchでrollback可能にします。既存v1 schemaはcompatibility fixtureだけが明示migrationし、runtime初期化DDLは持ちません。詳細は [Identity / Vault control plane and migrations](server-control-plane.md) を参照してください。

T05のrequest-time runtimeはGoとPostgreSQLです。TypeScript/D1 adapterは移行後機能のcompatibility contractを保護するtest対象として残り、T14までrequest handlerの意味論を比較するために検査します。Goはenvironmentを起動時にdecodeし、PostgreSQL rowをscan後に検査し、欠落・不正設定や未migration schemaをfail closedにします。`npm run check:environment` は静的frontend route、public build allowlist、Go起動、container assetの整合を照合します。

T09aのbilling境界はprovider factとsnapshotをtyped discriminantで検査し、Account/Vault、subscription、provider mapping、時刻順序、lifecycle shapeをpure coreで確定します。PostgreSQL adapterはnullable columnを明示的にscanして同じrecord invariantを再検査し、aggregate versionとunique receipt/checkpointを一transactionで更新します。同一時刻の別snapshotはIDで区別し、同一ID replayだけをduplicateとするため、時刻だけをidempotency keyとして扱いません。

`NEXT_PUBLIC_SITE_URL` は未設定または空なら公開既定URLを使います。設定時はabsolute HTTP(S) URLだけを受理し、不正値はmetadata moduleの初期化／buildを明示的に失敗させます。相対URL、HTTP(S)以外、非文字列をassertionで通しません。

## trust boundary

| 境界                          | 現在の検査                                                            | 担当Phase     |
| ----------------------------- | --------------------------------------------------------------------- | ------------- |
| Service Worker `message.data` | object、message type、URL配列、string、same-origin、内部/API path除外 | Phase 1 (#10) |
| DOM event target              | `Element` のruntime guard後にcard-link属性を読む                      | Phase 1 (#10) |
| Tiptap card-link attrs        | object、string、UUIDv7を小さなadapterで検査                           | Phase 1 (#10) |
| 合成互換fixture               | 現行のcard/body/mutation/conflict/sync形と固定UUIDv7                  | Phase 1 (#10) |
| networkのsync response        | 全体codec、重複／参照／ack subset、transaction前検証                  | Phase 2 (#11) |
| IndexedDB record              | 全storeをunknownからdecodeし、明示encodeでv1形式を維持                | Phase 2 (#11) |
| APIのsync request             | byte上限後、Request JSONをunknownから共通codecでdecode、400／413分類  | Phase 3 (#12) |
| D1 row / JSON column          | first／allとJSON parseをunknownからrow／Body codecでdecode            | Phase 3 (#12) |
| runtime environment           | public build allowlistとGo起動設定を分離し、静的成果物まで照合        | T05 (#420)    |
| public URL environment        | absolute HTTP(S) URLとしてparse、未設定時の既定値を明文化             | Phase 3 (#12) |
| Email OTP challenge／adapter  | branded ID・8桁code・digest・CAS state・rate keyをunknownからdecode   | Issue #112    |
| Vault別IndexedDB namespace    | session由来scopeから純粋導出し、DB別connection・削除結果を分離        | Issue #113    |

Phase 1〜3でcompiler、codec／brand、client／IndexedDB、API／D1／environmentと全面unsafe ruleを完成させました。親 #9 の要件1–30の証跡は `docs/type-safety-audit.md` に記録します。

## 第三者adapterの追加チェックリスト

- 境界の入力型は `unknown` または第三者が実際に保証する最小型か。
- object、配列、必須field、discriminant、数値範囲、ID形式を実行時に検査したか。
- optional fieldを `undefined` のまま必須fieldへ格上げしていないか。
- DOM nodeは `Element` 等のguard後に使用しているか。
- assertionがある場合、直前のguardと理由があり、範囲が最小か。
- malformed値、欠損値、正しい値を境界testで確認したか。
- adapterからapplication/domainへ渡す型に第三者固有の曖昧さが漏れていないか。
- API／database境界なら、検証失敗前後のstorage snapshotが同一か。
- 新しいenvironment値なら、public allowlist、Go起動decode、成果物への非漏えいを照合したか。
- schema変更なら、Drizzle、migration、runtime DDLのdrift testを更新したか。

## invalid dataの回復方針

不正なnetwork／API inputは破棄し、端末側pending mutationを残して再試行可能にします。不正なIndexedDB recordは自動削除・上書きせず、利用者向け失敗表示と診断を残します。不正なD1 row／JSONは200 responseとして返さず500で停止し、該当requestによる追加writeを行いません。D1の修復は検証済みbackupや管理手順による明示操作とし、request処理中に推測修復しません。

## 共通の検証入口

`npm run verify` がlocalとCIの共通入口です。format check、全runtime typecheck、全面unsafe lint、unit／D1互換integration／Go PostgreSQL integration／architecture test、production build、Desktop ChromeとPixel 7相当のE2Eを順に実行します。production build後は `dist/frontend/sw.js` のmessage guardと、静的frontend route／Go runtime設定の整合も検査します。

個別調査には `npm run test:integration`、`npm run test:architecture`、`npm run check:environment` を使えます。CIとtestはlocal fixture／Miniflareだけを使い、本番D1、本番データ、デプロイを使用しません。

## Pure coreとIssue実行管理

業務判断、変換、状態遷移はtyped pure coreへ置き、React、clock、UUID、network、IndexedDB、D1、DOM等はadapterから検証・生成済み値を渡します。core→concrete effectの逆依存はarchitecture testで機械検査し、意味論的な純粋性と入力非変更はunit test/reviewで補います。

client data pathは `lib/application/notes-runtime.ts` の `NotesRepository`、`SyncTransport`、`Clock`、`IdGenerator`、connectivity、offline preparation portを境界とします。`lib/client/notes-store.tsx` はこれらを注入され、IndexedDB、fetch、Date、UUID、navigator、Service Workerのconcrete実装をimportしません。現行互換adapterはcomposition rootで明示的な `LEGACY_NOTES_SCOPE` に束ねます。このscopeは既存DB名とv1 endpointだけを固定し、`CardRecord` や本文へAccount/Vault情報を追加しません。

認証済みlocal storageは `VaultNotesScope` のbranded AccountId/VaultIdからpure functionでversioned database名を導出し、scope-bound `NotesRepository`を構築します。IndexedDB adapterはdatabase名ごとのconnection registryを持ち、異なるVaultでpromiseやconnectionを共有しません。session rotationでは同じoffline replicaを使うためSessionId/EpochはDB名へ含めません。close/deleteは対象scopeだけに作用し、`deleteDatabase`のblockedとfailureをtyped resultとしてsuccessから分離します。現在のrouteは引き続きlegacy compositionであり、#148のbrowser logout purgeが完了する前にproduction loginへ接続しません。詳細は [Vault-scoped IndexedDB boundary](vault-indexeddb.md) を参照してください。

client operation lifecycleはload/save/sync開始時のAccountId/VaultId/SessionId/SessionEpochとProvider固有operation epochをtokenへcaptureします。pureな継続判定はunmount/logout、session rotation、Vault切替、runtime再生成後のcompletionをfail closedで拒否します。特にnetwork response後かつrepository apply前に再検査するため、stale responseはmutation ack/cursorへ到達しません。queued saveもrepository write前後で検査し、旧completionは新stateやfollow-up syncを変更しません。既に開始した低水準transactionは#113の旧Vault namespaceへ限定され、crash progressは#144、tab coordinationは#147、worker停止と削除は#148が担当します。詳細は [Notes operation lifecycle boundary](notes-operation-lifecycle.md) を参照してください。

logout purge coreは `logout-purge/v1` markerをAccountId/VaultId/SessionId/SessionEpoch、target、attempt、revision、failure reasonだけに制限します。pure transitionはruntime fenceからdeletion verificationまで7 targetを順序づけ、別generation、duplicate、逆順、blocked/timeout/failureで完了を進めません。crash時のrunning targetはinterruptedへ復元し、progress portはCAS writeとexpected generation/revision clearだけを公開します。durable completed markerは作らず、最終verification後のconditional clear成功だけを完了とするため、clear失敗やcrashではmarkerが残りruntime gateはfail closedです。fake adapterはproduction compositionからarchitecture testで隔離します。詳細は [Crash-resumable logout purge core](logout-purge-core.md) を参照してください。

server content repositoryは認証済み`VaultContext`からAccount/Vault ownershipをcontrol-plane public APIで確認し、生成時のVaultId・PartitionId・routing revisionへ固定します。公開repositoryのcard/mutation/conflict操作はVaultIdを引数に取らず、D1の全read/list/write/CAS/deleteが固定VaultIdとcurrent routeをpredicateへ含めます。同じ識別子を別Vaultで独立保持し、cross-tenantまたはstale routeはopaqueな`not-found`/`not-applied`としてfail closedになります。routingとcard CAS判断はpure core、D1 rowは`unknown`からcodecでdecodeします。詳細は [Vault-scoped server repository and tenant routing](vault-content-repository.md) を参照してください。

Service Workerのcache policyはmethod、origin、query、request mode、明示pathname allowlistだけから決まるpure predicateです。CacheStorageへ入るのは非個人化app shellとmanifest/favicon、`/assets/` build assetだけで、API、auth/OAuth、billing/account、query付きまたはallowlist外requestはnetwork-onlyです。canonical deep navigationは個別HTMLを保存せず共通shellへfallbackします。logout purge commandは外部messageをdecodeし、全FUKAMU cacheが消えたことを再確認してからだけtyped ackを返します。

Identity/session境界はAccount/Vault/Session/Identity IDとSessionEpochを別brandで表し、storage/cookie/headerを`unknown`からdecodeします。pure session coreはactive/revoked、expiry、rotation、revocation、operation epochを判定し、clock・token/UUID生成・cookie/storage accessを行いません。server requestからの`VaultContext`はverified sessionだけから導出し、request bodyのtenant fieldを読みません。unsafe methodはexact Originと`Sec-Fetch-Site: same-origin`を必須とし、`__Host-fukamu_session`はSecure/HttpOnly/SameSite=Strict/Path=/を固定します。clientのauthenticated composition gateはanonymous時にruntime factory、NotesProvider、IndexedDB、sync、Service Worker preparationを起動しません。

Logout coordinationはversionedな`purge-request`/`peer-quiesced`/`purge-completed`を`unknown`からdecodeし、Account/Vault/Session/epoch/attempt/UUID tab IDへbindします。peer stateとack集約はpure discriminated unionで、duplicate、逆順、別generation、wrong ownerを拒否します。authenticated runtimeはpurge markerをshared Web Lock取得の前後で検査し、Providerをlayout phaseでfenceしてからlockを解放します。BroadcastChannel、Web Locks、timeout、UUID生成はbrowser adapterだけに置き、unsupported capabilityを成功へfallbackしません。詳細は [Logout runtime fence and multi-tab coordination](logout-coordination.md) を参照してください。

Browser logout purgeはVault外のcontrol IndexedDBへversioned markerをtransactional CAS保存し、pure runnerが既存7 targetの開始・effect・結果を順に永続化します。IndexedDB、CacheStorage、Service Worker、graph Workerはclient adapterに限定し、blocked/timeout/unsupported/verification failureを完了として扱いません。最終再確認とmarkerのconditional clear後だけ完了します。詳細は [Browser logout purge](browser-logout-purge.md) を参照してください。

退会browser handoff coreはstart request前のdurable marker、最初のsession revoke確認、既存logout purge、残りserver statusをtyped phaseで順序づけます。pure transitionは不正なgeneration・revision・順序を拒否し、runnerはsession revokeがretry中ならlocal contentを保持し、serverが先へ進んだ後だけ既存purge runnerを開始します。server response、永続化、clock、entropy、fetch、DOMはportの外側に限定します。詳細は [Account deletion browser handoff](account-deletion-browser-handoff.md) を参照してください。

退会browser adapterは非content control IndexedDBのadditive schemaにlogout markerと独立したhandoff storeを持ち、generation/revision CASで更新します。HTTPはidempotency keyまたはcontinuation capabilityだけをsame-origin/no-store/no-redirectで送り、成功bodyも`unknown`からdecodeします。Web Crypto、Date、fetch、IndexedDB、既存browser logout purgeのcompositionは`lib/client`に限定し、legacy local routeへ暗黙接続しません。

退会UIはpure reducer/runner resultだけを描画し、認証済み・匿名分岐の外側にoptional boundaryとして置きます。durable marker検査が完了するまでruntime fence、NotesProvider、IndexedDB、syncを開始せず、session revoke後の匿名reloadでもhandoffを再開します。React/DOMはcomponent adapterに留め、Account/Vault generationは認証済みVaultContextからだけ渡します。

Vault DEK rotationはgenerating/promoting/completedとCAS revisionをpure state machineで管理し、D1/KMSをservice adapterの外側に置きます。D1 repositoryはAccountId/VaultId ownerを全load/mutationで固定し、wrapped metadataの永続化後だけoperation rowをcompletedへ進めます。pending中はsource、completed後だけtargetをlogical write versionとし、全旧versionをmixed read用に保持します。raw DEK handleは生成結果の検証後に必ずdestroyし、old keyの削除やproduction KMS操作は行いません。詳細は [Vault DEK rotation lifecycle](dek-rotation.md) を参照してください。

既存暗号文の再暗号化は、昇格済みwrite DEKと結びついたtyped checkpointでVault内を最大100件ずつ走査します。旧暗号文を記録済みAADで認証してからfresh ciphertextをimmutable保存し、logical revisionを変えずにmetadata CASと旧object delete outboxを同一D1 batchで確定します。CAS競合、途中失敗、checkpointより前へ追加された旧version、旧DEKのpending writeを明示的な再試行状態にし、対象なしではR2/KMSを呼びません。詳細は [Vault DEK rotation lifecycle](dek-rotation.md#existing-ciphertext-re-encryption) を参照してください。

DEK recovery drillはversioned backup manifestとciphertextをTypeScriptの`unknown`／Goのstrict JSON boundaryからdecodeし、共有fixture上のmixed旧/新versionを正確なVault/object/revision AADで認証します。plaintext/raw keyをreceiptへ含めず、incomplete checkpoint、missing/wrong key、swap、retention違反をblocked resultにします。retirement pure gateはactive/pending/backup/drill evidenceが揃ってもdeleteを返さず、別のproduction key destruction承認が必要なterminal stateで停止します。Goのbackup portはcopying in-memory fixtureだけで、production providerへ接続しません。詳細は [DEK rotation recovery drill and retirement gate](dek-rotation-recovery.md) を参照してください。

Personal Vault quotaは表示文字、serialized plaintext bytes、ciphertext bytes、request bytes、Vault usageを別のrefined measureとして扱います。表示文字は正規化しないUnicode scalar valueで数え、unpaired surrogateを拒否します。pure transitionはcreate/update/delete deltaとexact limitを決め、scope-bound ledgerがpositive reservationとD1 CASで並行上限を守ります。expired reservationは自動解放せず、content/journal側のdurable evidenceに基づく明示finalizeだけを許可します。authenticated Sync v2はEntitlementから得たlimitと実測値をこのledgerへ接続し、reservation、encrypted write、journal receipt、quota finalizeの順で確定します。詳細は [Personal Vault quota policy](quota-policy.md)、[Vault quota ledger](quota-ledger.md)、[Sync v2 quota enforcement](sync-v2-quota.md) を参照してください。

Google OIDC境界はstate、nonce、PKCE verifier/challenge、authorization code、issuer、subject、client ID、redirect URIを別brandで表します。start/callback、provider verified claims、pending transaction、identity directoryの値はすべて`unknown`からdecodeし、exact redirect/issuer/audience、`azp`、expiry/issued-at、nonceをpure coreで判定します。transaction storeはstateを原子的にconsumeし、同じcallbackを再利用できません。emailはverified attributeであってidentity keyではなく、既存accountへのlink対象はrequest bodyではなくauthenticated `VaultContext`からだけ導出します。provider通信・signature/JWKS検証・entropy・clock・transaction/identity storage・Web Cryptoはport/adapter側に留めます。

カード作成・編集・競合解決・pending mutation構築は `lib/domain/card-transitions.ts` のpure functionが担当します。時刻とbranded IDは外側で一度生成して入力し、UUIDv7生成は `lib/client/id-generator.ts` に限定します。編集とmutation mode、予期可能なresolve失敗はdiscriminated unionで区別し、IndexedDB adapterだけが既存の例外へ変換します。

同期応答のack、送信中に生じた編集のrebase、server cardとの統合、conflict置換順序は `lib/sync/client-reconciliation.ts` がI/Oなしの適用計画として決定します。IndexedDB adapterは検証済み応答と同一transaction内で読んだsnapshotを渡し、返された操作を順番どおり実行します。要求後の画面編集との再統合も同moduleのpure functionが担当し、network待機中の内容を失わずserver側の正式IDとrevisionだけを取り込みます。transactionの開始位置、read/write順序、abort条件は変更しません。

初期化は `lib/application/initialization-lifecycle.ts` の `loading`、`awaiting-initial-sync`、`ready` からなる状態機械を正本とします。storage loadの成功／失敗とinitial sync完了はeventとしてpure reducerへ渡し、React adapterは独立したbooleanを保持しません。load失敗でも従来どおり初期化後の同期を試み、deep linkのfallbackはinitial sync試行完了まで待機します。表示境界の `initialized` はlifecycleから派生して既存contractを維持します。status modelはkindごとにretryableのliteral型を固定し、保存状態を同期状態より優先する全組合せをunit testします。

Issue分割、integration/work branch、PR base、merge gate、検査設定変更の扱い、main/production境界の正本は [Issue-based type-safe development workflow](development-workflow.md) です。利用者が対象を特定して直接許可するまではmainへ反映しません。
