import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const integrationBranch = 'codex/integration-type-safety-ui';

function normalizeWhitespace(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('issue-based delivery contract', () => {
  it('makes the workflow discoverable from the repository root and existing docs', async () => {
    const [agents, workflow, readme, typeSafety] = await Promise.all([
      readFile('AGENTS.md', 'utf8'),
      readFile('docs/development-workflow.md', 'utf8'),
      readFile('README.md', 'utf8'),
      readFile('docs/type-safety.md', 'utf8'),
    ]);

    expect(agents).toContain('docs/development-workflow.md');
    expect(readme).toContain('docs/development-workflow.md');
    expect(typeSafety).toContain('development-workflow.md');
    expect(workflow).toContain('## Main boundary');
    expect(normalizeWhitespace(workflow)).toContain(
      'one Issue, one work branch, and one PR',
    );
    expect(workflow).toContain(integrationBranch);
  });

  it('requires explicit user permission before main changes', async () => {
    const [agents, workflow] = await Promise.all([
      readFile('AGENTS.md', 'utf8'),
      readFile('docs/development-workflow.md', 'utf8'),
    ]);

    for (const source of [agents, workflow]) {
      expect(normalizeWhitespace(source)).toMatch(
        /direct, explicit (?:user )?instruction/,
      );
      expect(source).toContain('auto-merge');
      expect(source).toContain('draft');
      expect(source).toContain('cherry-pick');
    }
  });

  it('runs verification for PRs and pushes to the integration branch without deployment', async () => {
    const quality = await readFile('.github/workflows/quality.yml', 'utf8');
    const branchFilters = quality.match(
      new RegExp(`- ${integrationBranch.replaceAll('/', '\\/')}`, 'g'),
    );

    expect(branchFilters).toHaveLength(2);
    expect(quality).toContain('permissions:\n  contents: read');
    expect(quality).toContain('run: npm run verify');
    expect(quality).not.toMatch(/\b(?:deploy|publish)\b|wrangler\s+deploy/i);
  });
});
