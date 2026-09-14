import type { ReactNode } from 'react';

export function LegalDocument({
  eyebrow,
  title,
  summary,
  fixture,
  fixtureMessage,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  fixture: boolean;
  fixtureMessage?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-16">
      <p className="text-xs font-bold tracking-[0.18em] text-muted-foreground">
        {eyebrow}
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
        {summary}
      </p>
      {fixture && (
        <aside
          className="mt-7 rounded-2xl border border-amber-700/25 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
          aria-label="開発用表示"
          data-testid="legal-fixture-notice"
        >
          {fixtureMessage ??
            'これはローカル開発・テスト専用のサンプル表示です。実在する販売事業者情報や料金ではなく、契約や課金は行われません。'}
        </aside>
      )}
      <div className="mt-9">{children}</div>
    </main>
  );
}

export function LegalDefinitionList({
  items,
}: {
  items: readonly {
    readonly label: string;
    readonly value: ReactNode;
  }[];
}) {
  return (
    <dl className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      {items.map((item) => (
        <div
          key={item.label}
          className="grid gap-2 border-b px-5 py-5 last:border-b-0 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6 sm:px-7"
        >
          <dt className="text-sm font-semibold">{item.label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap text-sm leading-7 text-foreground/85">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
