import { describe, expect, test } from 'bun:test';
import { adfToText } from './adf-to-text.ts';
import { AtlassianError, atlassianSite, confluencePageId, jiraIssueKey } from './atlassian.ts';

const site = new URL('https://acme.atlassian.net');

describe('Atlassian references', () => {
  test('the site is normalized to its https origin', () => {
    expect(atlassianSite('https://ACME.atlassian.net/wiki/home', {}).toString()).toBe(
      'https://acme.atlassian.net/',
    );
    expect(() => atlassianSite('http://acme.atlassian.net', {})).toThrow(AtlassianError);
    expect(() => atlassianSite('https://me:pw@acme.atlassian.net', {})).toThrow(AtlassianError);
    expect(atlassianSite('http://localhost:1', { ATLASSIAN_ALLOW_HTTP: 'true' }).origin).toBe(
      'http://localhost:1',
    );
  });

  test('Confluence page ids come from ids and the common page URL shapes', () => {
    for (const ref of [
      '123456',
      'https://acme.atlassian.net/wiki/spaces/MB/pages/123456/Checkout+design',
      'https://acme.atlassian.net/wiki/spaces/MB/pages/edit-v2/123456',
      'https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=123456',
    ]) {
      expect(confluencePageId(ref, site)).toBe('123456');
    }
    expect(() => confluencePageId('https://acme.atlassian.net/wiki/x/AbCd', site)).toThrow(
      'Confluence page URL',
    );
    expect(() =>
      confluencePageId('https://evil.example/wiki/spaces/MB/pages/123456/X', site),
    ).toThrow('must be on acme.atlassian.net');
  });

  test('Jira issue keys come from keys and issue URLs', () => {
    expect(jiraIssueKey(' mb-42 ', site)).toBe('MB-42');
    expect(jiraIssueKey('https://acme.atlassian.net/browse/MB-42', site)).toBe('MB-42');
    expect(
      jiraIssueKey(
        'https://acme.atlassian.net/jira/software/projects/MB/boards/1?selectedIssue=MB-42',
        site,
      ),
    ).toBe('MB-42');
    expect(() => jiraIssueKey('https://evil.example/browse/MB-42', site)).toThrow('must be on');
    expect(() => jiraIssueKey('42', site)).toThrow('Jira issue key');
  });
});

describe('adfToText', () => {
  test('keeps headings, code, tables and links readable', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'GET /status' }] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Case' }] }],
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Poll' }] }],
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'inlineCard', attrs: { url: 'https://x.test/a' } }],
        },
      ],
    };
    expect(adfToText(doc)).toBe('## Scope\n\nGET /status\n\nCase | Poll\n\nhttps://x.test/a');
    expect(adfToText('plain v2 text ')).toBe('plain v2 text');
    expect(adfToText(null)).toBe('');
  });
});
