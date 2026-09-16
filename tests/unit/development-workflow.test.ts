import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const integrationBranch = 'integration/106-multi-user-production';
const semanticZoomIntegrationBranch =
  'integration/106-full-network-semantic-zoom';
const currentParent = '#106';
const currentBranchPoint = '2c7e968f6b4567f73a692f384b1b2c6d569040b7';
const semanticZoomParent = '#283';
const semanticZoomBranchPoint = '4a2780153bcdef82cd650d19f3c8c58b94f7944f';

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
    expect(agents).toContain(semanticZoomIntegrationBranch);
    expect(workflow).toContain(semanticZoomIntegrationBranch);
    expect(agents).toContain(currentParent);
    expect(workflow).toContain(currentParent);
    expect(agents).toContain(semanticZoomParent);
    expect(workflow).toContain(semanticZoomParent);
    expect(agents).toContain(currentBranchPoint);
    expect(workflow).toContain(currentBranchPoint);
    expect(agents).toContain(semanticZoomBranchPoint);
    expect(workflow).toContain(semanticZoomBranchPoint);
    expect(workflow).toContain('完了済み親 #41');
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
    const semanticZoomBranchFilters = quality.match(
      new RegExp(
        `- ${semanticZoomIntegrationBranch.replaceAll('/', '\\/')}`,
        'g',
      ),
    );
    const mainBranchFilters = quality.match(/- main/g);

    expect(branchFilters).toHaveLength(2);
    expect(semanticZoomBranchFilters).toHaveLength(2);
    expect(mainBranchFilters).toHaveLength(2);
    expect(quality).toContain("- 'work/**'");
    expect(quality).toContain('permissions:\n  contents: read');
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
    expect(agents).toContain('Feature bootstrap Issue #284');
    expect(workflow).toContain('self-bootstrap方式');
    expect(workflow).toContain('#284も同じ手順');
    expect(workflow).toContain('CI省略ではなく');
  });

  it('separates check weakening from ordinary implementation work', async () => {
    const workflow = await readFile('docs/development-workflow.md', 'utf8');
    expect(workflow).toContain('## 検査設定の変更');
    expect(workflow).toContain('別Issue');
    expect(workflow).toContain('test skip');
  });
});
