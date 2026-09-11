import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const integrationBranch = 'refactor/type-safe-functional';

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

  it('runs read-only verification for the integration branch without deployment', async () => {
    const quality = await readFile('.github/workflows/quality.yml', 'utf8');
    const branchFilters = quality.match(
      new RegExp(`- ${integrationBranch.replaceAll('/', '\\/')}`, 'g'),
    );

    expect(branchFilters).toHaveLength(2);
    expect(quality).toContain('permissions:\n  contents: read');
    expect(quality).toContain('run: npm run verify');
    expect(quality).not.toMatch(/\b(?:deploy|publish)\b|wrangler\s+deploy/i);
  });

  it('separates check weakening from ordinary implementation work', async () => {
    const workflow = await readFile('docs/development-workflow.md', 'utf8');
    expect(workflow).toContain('## 検査設定の変更');
    expect(workflow).toContain('別Issue');
    expect(workflow).toContain('test skip');
  });
});
