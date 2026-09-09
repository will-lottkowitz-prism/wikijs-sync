import { describe, it, expect } from 'vitest';
import {
  assetDirForFile,
  assetLinkForFile,
  fileForPagePath,
  fileMatchesContext,
  matchGlob,
  normalizeWikiPath,
  pagePathForFile,
  sanitizeWikiPath,
} from './pathmap';

const posix = (p: string) => p.replace(/\\/g, '/');
const ctx = { root: '/w/docs', wikiPath: 'Products/x' };
const legacy = { root: '/w/content', wikiPath: '' };

describe('pagePathForFile', () => {
  it('maps a nested file under the wiki path', () => {
    expect(pagePathForFile(ctx, '/w/docs/guide/intro.md')).toBe(
      'Products/x/guide/intro'
    );
  });
  it('maps top-level index.md to the wiki path itself', () => {
    expect(pagePathForFile(ctx, '/w/docs/index.md')).toBe('Products/x');
  });
  it('legacy (empty wikiPath) maps to a bare relative path', () => {
    expect(pagePathForFile(legacy, '/w/content/Blog/hi.md')).toBe('Blog/hi');
  });
  it('leaves an already-legal mixed-case path untouched', () => {
    expect(
      pagePathForFile(legacy, '/w/content/Servers/District/router.md')
    ).toBe('Servers/District/router');
  });
  it('sanitizes dots and spaces in the file name', () => {
    expect(pagePathForFile(ctx, '/w/docs/Node.js Notes.md')).toBe(
      'Products/x/Node-js-Notes'
    );
  });
  it('sanitizes an illegal folder segment', () => {
    expect(pagePathForFile(legacy, '/w/content/deep/v1.2/thing.md')).toBe(
      'deep/v1-2/thing'
    );
  });
  it('does not reserved-word-guard a non-first segment', () => {
    expect(pagePathForFile(ctx, '/w/docs/js/api.md')).toBe('Products/x/js/api');
  });
  it('leaves characters Wiki.js accepts verbatim (+, parens, #, comma)', () => {
    expect(pagePathForFile(legacy, '/w/content/Trac/V/OwnC++Notes.md')).toBe(
      'Trac/V/OwnC++Notes'
    );
    expect(
      pagePathForFile(legacy, '/w/content/oam/webadmin(secondrun).md')
    ).toBe('oam/webadmin(secondrun)');
  });
});

describe('sanitizeWikiPath', () => {
  const cases: Array<[string, string]> = [
    ['Servers/District/router', 'Servers/District/router'],
    ['Node.js Notes', 'Node-js-Notes'],
    ['abc//b', 'abc/b'],
    ['weird\\name', 'weirdname'], // Wiki.js parsePath strips '\' entirely
    ['dots...everywhere', 'dots-everywhere'],
    ['  spaced  ', 'spaced'], // spaces -> '-', then leading/trailing '-' trimmed
    ['trailing-', 'trailing'],
    ['café/über', 'café/über'], // accented letters kept
    ['Trac/V/OwnC++Notes', 'Trac/V/OwnC++Notes'], // '+' is legal in Wiki.js
    ['oam/webadmin(secondrun)', 'oam/webadmin(secondrun)'], // parens are legal
    ['a#b,c!d=e&f', 'a#b,c!d=e&f'], // none of these are rejected or stripped
    ['quote"pipe|lt<gt>colon:star*q?', 'quotepipeltgtcolonstarq'], // stripped set
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(sanitizeWikiPath(input)).toBe(expected);
  });

  it('prefixes a reserved / locale / 1-char first segment with _', () => {
    expect(sanitizeWikiPath('js/api')).toBe('_js/api');
    expect(sanitizeWikiPath('en/intro')).toBe('_en/intro');
    expect(sanitizeWikiPath('x/y')).toBe('_x/y');
  });

  it('is idempotent', () => {
    for (const [input] of cases) {
      expect(sanitizeWikiPath(sanitizeWikiPath(input))).toBe(
        sanitizeWikiPath(input)
      );
    }
    expect(sanitizeWikiPath(sanitizeWikiPath('js/api'))).toBe('_js/api');
  });

  it('produces a path Wiki.js accepts (no ., space, \\ or //)', () => {
    for (const messy of [
      'a.b.c/d e/f\\g',
      'v1.2.3/notes',
      'My Docs//Sub Section',
    ]) {
      const out = sanitizeWikiPath(messy);
      expect(out).not.toMatch(/[.\s\\]/);
      expect(out).not.toContain('//');
    }
  });
});

describe('fileForPagePath', () => {
  it('maps a page under the wiki path back to a local file', () => {
    expect(posix(fileForPagePath(ctx, 'Products/x/guide/intro'))).toBe(
      '/w/docs/guide/intro.md'
    );
  });
  it('maps the wiki path itself to index.md', () => {
    expect(posix(fileForPagePath(ctx, 'Products/x'))).toBe('/w/docs/index.md');
  });
  it('legacy maps a page path straight under the content dir', () => {
    expect(posix(fileForPagePath(legacy, 'Blog/hi'))).toBe(
      '/w/content/Blog/hi.md'
    );
  });
});

describe('assets', () => {
  it('builds a server-absolute asset link', () => {
    expect(assetLinkForFile(ctx, '/w/docs/images/topo.png')).toBe(
      '/Products/x/images/topo.png'
    );
  });
  it('builds the wiki-relative asset folder', () => {
    expect(assetDirForFile(ctx, '/w/docs/images/topo.png')).toBe(
      'Products/x/images'
    );
    expect(assetDirForFile(ctx, '/w/docs/topo.png')).toBe('Products/x');
  });
});

describe('normalizeWikiPath', () => {
  it('trims slashes and whitespace', () => {
    expect(normalizeWikiPath('  /Products/x/  ')).toBe('Products/x');
    expect(normalizeWikiPath(undefined)).toBe('');
  });
});

describe('matchGlob', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**/*.md', 'docs/a/b.md', true],
    ['**/*.md', 'a.md', true],
    ['**/*.md', 'a.txt', false],
    ['drafts/**', 'drafts/x/y.md', true],
    ['drafts/**', 'drafts', true],
    ['drafts/**', 'draftsfoo/x', false],
    ['*.tmp', 'x.tmp', true],
    ['*.tmp', 'sub/x.tmp', false],
    ['**/.*', 'a/.secret', true],
    ['**/node_modules/**', 'a/node_modules/b/c.js', true],
    ['docs/**/*.md', 'docs/deep/x.md', true],
  ];
  it.each(cases)('%s vs %s -> %s', (glob, rel, expected) => {
    expect(matchGlob(glob, rel)).toBe(expected);
  });
});

describe('fileMatchesContext', () => {
  const base = { root: '/w/docs', wikiPath: '', exclude: ['**/.*'] };
  it('excludes dotfiles', () => {
    expect(fileMatchesContext(base, '/w/docs/.wikisync.json')).toBe(false);
  });
  it('allows normal files with no include list', () => {
    expect(fileMatchesContext(base, '/w/docs/page.md')).toBe(true);
  });
  it('applies a whitelist', () => {
    const wl = { ...base, include: ['**/*.md'] };
    expect(fileMatchesContext(wl, '/w/docs/page.md')).toBe(true);
    expect(fileMatchesContext(wl, '/w/docs/image.png')).toBe(false);
  });
  it('exclude wins over include', () => {
    const both = { ...base, include: ['**/*.md'], exclude: ['drafts/**'] };
    expect(fileMatchesContext(both, '/w/docs/drafts/wip.md')).toBe(false);
  });
});
