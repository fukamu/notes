package localcommerce

import (
	"context"

	"github.com/fukamu/notes/backend/internal/legal"
)

const (
	fixtureCancellationPolicy = "解約はアカウントの契約管理画面からいつでも申し込めます。無料期間中に解約した場合は初回料金が発生せず、利用権停止事由がない限り無料期間の終了時まで利用できます。初回課金後に解約した場合は次回以降の自動更新を停止し、利用権停止事由がない限り支払済みの利用期間の終了時まで利用できます。サブスクリプションの解約とアカウントの退会は別の手続です。"
	fixtureRefundPolicy       = "提供開始後の料金は日割り計算せず、通常は返金しません。ただし、重複課金、当社の責めに帰すべき事由によりサービスを提供できなかった場合、または法令上返金が必要な場合は、該当する範囲を返金します。"
)

// TermsSource is deliberately immutable test data. It is available only to
// the explicitly selected local-fixture composition and is not an approved
// production legal source.
type TermsSource struct{}

var _ legal.CurrentTermsSource = TermsSource{}

func (TermsSource) ReadCurrent(context.Context) (legal.CurrentTermsSourceValue, error) {
	return legal.CurrentTermsSourceValue{
		Disclosure:       localTermsDisclosure(),
		AcceptancePolicy: legal.AcceptancePolicy{Kind: legal.AcceptanceInitialRelease},
	}, nil
}

// OfferSource is the matching immutable, no-network commerce fixture.
type OfferSource struct{}

var _ legal.CurrentContractOfferSource = OfferSource{}

func (OfferSource) ReadCurrent(context.Context) (legal.LegalCommerceDisclosure, error) {
	return localOfferDisclosure(), nil
}

func localOfferDisclosure() legal.LegalCommerceDisclosure {
	return legal.LegalCommerceDisclosure{
		SchemaVersion: 1,
		Seller: legal.LegalCommerceSeller{
			LegalName:      "FUKAMU Notes 開発用サンプル株式会社",
			Representative: "開発用サンプル責任者",
			PostalAddress:  "〒000-0000 開発用サンプル住所",
			Phone:          "000-0000-0000",
			SupportURL:     "http://localhost:3100/legal/commercial-transactions",
		},
		Offer: legal.LegalCommerceOffer{
			PlanName: "FUKAMU Notes 月額プラン", PriceYen: 980,
			BillingPeriod: legal.BillingPeriodMonthly, TaxIncluded: true, TrialDays: 14,
		},
		AdditionalFees:     "本サービスの利用に必要なインターネット接続料金、通信料金および利用端末の費用は利用者の負担です。",
		CancellationPolicy: fixtureCancellationPolicy,
		RefundPolicy:       fixtureRefundPolicy,
		SpecialTerms:       "前記以外の特別な販売条件はありません。",
		SystemRequirements: []string{
			"最新安定版のGoogle Chrome、Safari、Mozilla FirefoxまたはMicrosoft Edge",
			"JavaScript、CookieおよびIndexedDBを利用できること",
		},
		EffectiveDate: "2026-09-15",
	}
}

func localTermsDisclosure() legal.TermsDisclosure {
	return legal.TermsDisclosure{
		SchemaVersion: 1, TermsVersion: "terms-v1:2026-09-15", EffectiveDate: "2026-09-15",
		ServiceName: "FUKAMU Notes",
		Operator: legal.TermsOperator{
			LegalName:  "FUKAMU Notes 開発用サンプル株式会社",
			SupportURL: "http://localhost:3100/legal/commercial-transactions",
		},
		ServiceEligibility: "利用登録には、法定代理人の同意を要せず、ご本人が有料サブスクリプション契約を有効に締結できることが必要です。",
		AccountSecurity:    "利用者は、Google LoginまたはEmail OTPに使用するアカウント、登録連絡先および利用端末を適切に管理し、第三者による不正利用を確認した場合は速やかに問い合わせ窓口へ連絡するものとします。",
		Authentication: legal.TermsAuthentication{
			GoogleLogin: true, EmailOTP: true, Password: false, SharedVault: false,
		},
		ProhibitedActivities: []string{
			"法令、公序良俗または本規約に違反する行為",
			"第三者の知的財産権、プライバシーその他の権利を侵害する行為",
			"不正アクセス、認証情報の不正取得その他本サービスの安全性を損なう行為",
			"本サービスまたはその基盤へ過度な負荷を与え、運営を妨害する行為",
			"アカウントを第三者へ譲渡もしくは貸与し、または本サービスを無断で再販売する行為",
		},
		UserContent: legal.TermsUserContent{
			Ownership: "retained-by-user", LicenseScope: "minimum-necessary-for-service",
			LicensePurpose: "利用者contentの権利は利用者に留保されます。利用者は当社に対し、本サービスにおける保存、暗号化、同期、表示、バックアップ、保守およびセキュリティ対応に必要な最小範囲で、利用者contentを複製その他取り扱う権限を付与します。この権限は本サービスの提供以外の目的には使用しません。",
		},
		Billing: legal.TermsBilling{
			PaidOnly: true, TrialDays: 14, FirstChargeDay: 15, AutomaticRenewal: true,
			CancellationPolicy:              fixtureCancellationPolicy,
			RefundPolicy:                    fixtureRefundPolicy,
			PaymentFailureLock:              "immediate-online-lock",
			ResumePolicy:                    "invoice-paid-only",
			CancellationSeparateFromAccount: true,
		},
		DataHandling: legal.TermsDataHandling{
			OneAccountOnePersonalVault: true, LocalContentOnLogout: "deleted-on-logout",
			LiveDataOnAccountDeletion: "deleted-on-account-deletion", BackupMaximumDays: 30,
		},
		SuspensionPolicy:      "支払い失敗、追加認証要求、本規約への重大な違反、不正利用またはサービスの安全を守るために必要な場合、当社は必要な範囲で本サービスの利用を停止できます。合理的に可能な場合は理由と解除方法を通知します。停止中も支払い、解約、退会および問い合わせに必要な経路は利用できます。支払いに基づく停止は、未払いinvoiceの支払いを確認した場合に限り解除します。",
		MaintenanceAndChanges: "保守、機能変更または障害対応のため、本サービスの全部または一部を変更し、または一時停止することがあります。合理的に可能な場合は事前に通知しますが、セキュリティ対応、法令対応または緊急障害への対応では事後の通知となることがあります。",
		ServiceTermination:    "本サービスを終了する場合は、原則として終了日の30日前までに、登録された連絡先または本サービス内の専用ページで通知し、利用者データの取扱いと退会手続を案内します。ただし、セキュリティ上の緊急事態、法令上の要請その他やむを得ない事情がある場合は、この期間を短縮することがあります。",
		IntellectualProperty:  "本サービス、ソフトウェア、画面、文書その他当社が提供するものに関する知的財産権は、当社または正当な権利者に帰属します。利用者contentの権利は利用者に留保されます。",
		Liability:             "当社の債務不履行または不法行為により利用者に損害が生じ、当社が損害賠償責任を負う場合、当社の通常の過失による責任は、利用者に現実に生じた直接かつ通常の損害に限り、その総額は損害発生時までの直近12か月間に利用者が本サービスについて当社へ支払った料金の総額を上限とします。この制限は、当社の故意もしくは重過失による場合、生命もしくは身体に生じた損害その他法令上制限できない責任には適用しません。",
		Notices:               "当社からの重要な通知は、登録された連絡先への送信または本サービス内の専用ページへの掲載により行います。通知の効力発生時期は適用法令に従います。利用者は登録した連絡先を最新の状態に保つものとします。",
		GoverningLawAndVenue:  "本規約は日本法を準拠法とします。本サービスに関して生じた紛争については、当社の本店所在地を管轄する地方裁判所を第一審の合意管轄裁判所とします。ただし、この合意は消費者に法令上認められる裁判管轄を排除しません。",
		Amendments: legal.TermsAmendments{
			Procedure:              "本規約を変更する場合は、変更内容、変更後のversionおよび施行日を、原則として施行日の30日前までに登録された連絡先または本サービス内の専用ページで通知します。セキュリティ上の緊急事態または法令対応では、合理的に必要な範囲で期間を短縮することがあります。利用者の権利または義務へ重大な影響を与える変更は、法務確認に基づき必要な場合に再同意を求めます。",
			MaterialChangeHandling: "legal-review-required-before-enforcement",
		},
	}
}
