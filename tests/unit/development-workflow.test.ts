import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const completedTokenParent = '#391';
const completedTokenMainPr = '#396';
const retiredTokenIntegrationBranch = 'integration/391-shared-design-tokens';
const staleTokenBranchPoint = 'ceefec936ea0c30143153069f3b7f170bc358ae1';

function normalizeWhitespace(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('issue-based delivery contract', () => {
  it('is discoverable from the root and existing engineering docs', async () => {
    const [agents, workflow, readme, typeSafety] = await Promise.all([
      readFile('AGENTS.md', 'utf8'),
      readFile('docs/development-workflow.md', 'utf8'),
      readFile('README.md', 'utf8'),
      readFile('docs/type-safety.md', 'utf8'),
    ]);

    expect(agents).toContain('docs/development-workflow.md');
    expect(readme).toContain('docs/development-workflow.md');
    expect(typeSafety).toContain('development-workflow.md');
    expect(workflow).toContain('## 設計の依存方向');
    expect(workflow).toContain('## Mainとproduction境界');
    expect(normalizeWhitespace(workflow)).toContain(
      '原則1 Issue / 1 work branch / 1 PR',
    );
    expect(agents).toContain(completedTokenParent);
    expect(workflow).toContain(completedTokenParent);
    expect(agents).toContain(completedTokenMainPr);
    expect(workflow).toContain(completedTokenMainPr);
    expect(agents).toContain(retiredTokenIntegrationBranch);
    expect(workflow).toContain(retiredTokenIntegrationBranch);
    expect(agents).not.toContain(staleTokenBranchPoint);
    expect(workflow).not.toContain(staleTokenBranchPoint);
    expect(workflow).toContain('最新 `main`');
    expect(workflow).toContain('`integration/<parent>-<slug>`');
    expect(workflow).toContain('固定しません');
  });

  it('requires direct user permission before any main update', async () => {
    const [agents, workflow] = await Promise.all([
      readFile('AGENTS.md', 'utf8'),
      readFile('docs/development-workflow.md', 'utf8'),
    ]);

    for (const source of [agents, workflow]) {
      const normalized = normalizeWhitespace(source);
      expect(normalized).toMatch(
        /direct, explicit user instruction|直接、明示的に許可/,
      );
      expect(source).toContain('auto-merge');
      expect(source).toMatch(/draft/i);
      expect(source).toContain('cherry-pick');
    }
  });

  it('runs read-only verification for main and every delivery branch without deployment', async () => {
    const [quality, goModule, dockerfile, compose] = await Promise.all([
      readFile('.github/workflows/quality.yml', 'utf8'),
      readFile('backend/go.mod', 'utf8'),
      readFile('deploy/Dockerfile', 'utf8'),
      readFile('deploy/compose.test.yaml', 'utf8'),
    ]);
    const integrationBranchFilters = quality.match(/- 'integration\/\*\*'/g);
    const mainBranchFilters = quality.match(/- main/g);

    expect(integrationBranchFilters).toHaveLength(2);
    expect(mainBranchFilters).toHaveLength(2);
    expect(quality).toContain("- 'work/**'");
    expect(quality).not.toContain('- integration/391-shared-design-tokens');
    expect(quality).not.toContain('- integration/385-edit-conflict-resolution');
    expect(quality).toContain('permissions:\n  contents: read');
    expect(quality).toContain('timeout-minutes: 30');
    expect(quality).toContain('uses: actions/checkout@v7');
    expect(quality).toContain('uses: actions/setup-node@v7');
    expect(quality).toContain('node-version: 22.13.0');
    expect(quality).toContain('uses: actions/setup-go@v6');
    expect(quality).toContain('go-version: 1.27.1');
    expect(quality).toContain('cache: false');
    expect(quality).toContain('run: npm ci');
    expect(quality).toContain(
      'run: npx playwright install --with-deps chromium',
    );
    expect(quality).toContain('run: npm run verify');
    const packageSource = await readFile('package.json', 'utf8');
    expect(packageSource).toContain('"go:check"');
    expect(packageSource).toContain('go -C backend test -race ./...');
    expect(packageSource).toContain('go:test:integration');
    expect(goModule).toContain('go 1.27.1');
    expect(dockerfile).toMatch(
      /golang:1\.27\.1-alpine@sha256:[a-f0-9]{64} AS go-build/,
    );
    expect(dockerfile).toContain('COPY backend/go.mod backend/go.sum ./');
    expect(dockerfile).toContain('FROM scratch AS static-assets');
    expect(dockerfile).toMatch(/\nFROM scratch\n/);
    expect(quality).toContain('NOTES_TEST_DATABASE_URL');
    expect(quality).toContain(
      'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873',
    );
    expect(compose).toContain(
      'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873',
    );
    expect(compose).toContain('127.0.0.1:55432:5432');
    expect(quality).not.toContain('codex/integration-type-safety-ui');
    expect(quality).not.toContain('refactor/type-safe-functional');
    expect(quality).not.toMatch(
      /\b(?:deploy|deployment|publish)\b|wrangler\s+deploy|d1\s+(?:execute|migrations\s+apply)/i,
    );
  });

  it('records the narrow bootstrap transition without weakening its CI gate', async () => {
    const [agents, workflow] = await Promise.all([
      readFile('AGENTS.md', 'utf8'),
      readFile('docs/development-workflow.md', 'utf8'),
    ]);

    expect(agents).toContain('bootstrap exception');
    expect(agents).toContain('exact work-branch head commit');
    expect(workflow).toContain('bootstrap移行');
    expect(workflow).toContain('CI省略ではなく');
  });

  it('separates check weakening from ordinary implementation work', async () => {
    const workflow = await readFile('docs/development-workflow.md', 'utf8');
    expect(workflow).toContain('## 検査設定の変更');
    expect(workflow).toContain('別Issue');
    expect(workflow).toContain('test skip');
  });
});
