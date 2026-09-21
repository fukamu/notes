import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const integrationBranch = 'integration/391-shared-design-tokens';
const currentParent = '#391';
const currentBranchPoint = 'ceefec936ea0c30143153069f3b7f170bc358ae1';
const upstreamParent = '#385';
const upstreamIntegrationBranch = 'integration/385-edit-conflict-resolution';

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
    expect(workflow).toContain(integrationBranch);
    expect(agents).toContain(currentParent);
    expect(workflow).toContain(currentParent);
    expect(agents).toContain(currentBranchPoint);
    expect(workflow).toContain(currentBranchPoint);
    expect(agents).toContain(upstreamParent);
    expect(workflow).toContain(upstreamParent);
    expect(agents).toContain(upstreamIntegrationBranch);
    expect(workflow).toContain(upstreamIntegrationBranch);
    expect(workflow).toContain('完了済み親 #106');
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

  it('runs read-only verification for main and the integration branch without deployment', async () => {
    const quality = await readFile('.github/workflows/quality.yml', 'utf8');
    const branchFilters = quality.match(
      new RegExp(`- ${integrationBranch.replaceAll('/', '\\/')}`, 'g'),
    );
    const mainBranchFilters = quality.match(/- main/g);
    const upstreamBranchFilters = quality.match(
      new RegExp(`- ${upstreamIntegrationBranch.replaceAll('/', '\\/')}`, 'g'),
    );

    expect(branchFilters).toHaveLength(2);
    expect(mainBranchFilters).toHaveLength(2);
    expect(upstreamBranchFilters).toHaveLength(2);
    expect(quality).toContain("- 'work/**'");
    expect(quality).not.toContain('- integration/376-navigation-continuity');
    expect(quality).toContain('permissions:\n  contents: read');
    expect(quality).toContain('timeout-minutes: 30');
    expect(quality).toContain('uses: actions/checkout@v7');
    expect(quality).toContain('uses: actions/setup-node@v7');
    expect(quality).toContain('node-version: 22.13.0');
    expect(quality).toContain('run: npm ci');
    expect(quality).toContain(
      'run: npx playwright install --with-deps chromium',
    );
    expect(quality).toContain('run: npm run verify');
    expect(quality).not.toContain('codex/integration-type-safety-ui');
    expect(quality).not.toContain('refactor/type-safe-functional');
    expect(quality).not.toMatch(
      /\b(?:deploy|deployment|publish)\b|wrangler\s+deploy|d1\s+(?:execute|migrations\s+apply)/i,
    );
  });

  it('records the approved self-bootstrap without weakening its CI gate', async () => {
    const [agents, workflow] = await Promise.all([
      readFile('AGENTS.md', 'utf8'),
      readFile('docs/development-workflow.md', 'utf8'),
    ]);

    expect(agents).toContain('self-bootstrap CI');
    expect(agents).toContain('exact head commit');
    expect(workflow).toContain('self-bootstrap方式');
    expect(workflow).toContain('CI省略ではなく');
  });

  it('separates check weakening from ordinary implementation work', async () => {
    const workflow = await readFile('docs/development-workflow.md', 'utf8');
    expect(workflow).toContain('## 検査設定の変更');
    expect(workflow).toContain('別Issue');
    expect(workflow).toContain('test skip');
  });
});
