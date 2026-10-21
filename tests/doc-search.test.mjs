import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    getDocExcerpt,
    getDocSection,
    loadChunks,
    MAX_EXCERPT_LENGTH,
    MAX_SECTION_PAGE_LENGTH,
    searchDocs,
} from '../dist/doc-search.js';

function fixture(markdown) {
    const expected = path.resolve('F:/Temp').toLowerCase();
    for (const [name, value] of Object.entries({
        TEMP: process.env.TEMP,
        node: os.tmpdir(),
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
    })) {
        if (!value && ['TMP', 'TMPDIR'].includes(name)) continue;
        assert.ok(value && path.isAbsolute(value), `${name} must be absolute`);
        assert.equal(
            path
                .resolve(value)
                .replace(/[\\/]+$/, '')
                .toLowerCase(),
            expected
        );
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-doc-search-'));
    fs.writeFileSync(path.join(root, '.run-owner'), randomUUID());
    fs.writeFileSync(path.join(root, 'Guide.md'), markdown);
    // Retained intentionally: no recursive fixture cleanup.
    return root;
}

test('retains complete long sections and finds late matches with centered excerpts', () => {
    const body = `${'opening '.repeat(2000)}lateNeedle ${'closing '.repeat(200)}`.trim();
    const chunks = loadChunks(fixture(`## Long section\n${body}`));
    assert.equal(chunks[0].body, body);
    const hits = searchDocs('lateNeedle', 5, chunks);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].chunk, chunks[0]);
    const excerpt = getDocExcerpt(hits[0].chunk, 'lateNeedle', 120);
    assert.equal(excerpt.text.length, 120);
    assert.ok(excerpt.start > 12000);
    assert.match(excerpt.text, /lateNeedle/);
    assert.equal(excerpt.text, body.slice(excerpt.start, excerpt.end));
    assert.equal(excerpt.totalLength, body.length);
});

test('stable ids ignore unrelated section order and distinguish duplicate headings', () => {
    const root = fixture(
        '## Repeat\nfirst\n## Other\nother\n## Repeat\nsecond\n### Symbols # /\nlast'
    );
    const original = loadChunks(root);
    assert.equal(new Set(original.map((chunk) => chunk.id)).size, original.length);
    fs.writeFileSync(
        path.join(root, 'Guide.md'),
        '## Inserted\nnew\n## Repeat\nfirst\n## Repeat\nsecond\n### Symbols # /\nlast\n## Other\nother'
    );
    const reordered = loadChunks(root);
    for (const chunk of original) {
        assert.equal(reordered.find((item) => item.body === chunk.body).id, chunk.id);
    }
});

test('full-section pagination reconstructs all text with bounded pages', () => {
    const body = '0123456789'.repeat(3500);
    const chunks = loadChunks(fixture(`## Pages\n${body}`));
    let offset = 0;
    let result = '';
    let page;
    do {
        page = getDocSection(chunks[0].id, offset, Number.MAX_SAFE_INTEGER, chunks);
        assert.ok(page.text.length <= MAX_SECTION_PAGE_LENGTH);
        assert.equal(page.start, offset);
        assert.equal(page.end - page.start, page.text.length);
        assert.equal(page.totalLength, body.length);
        assert.equal(page.file, 'Guide.md');
        assert.equal(page.heading, 'Pages');
        result += page.text;
        offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(result, body);
    for (const beyond of [body.length, body.length + 20, Number.MAX_SAFE_INTEGER]) {
        const end = getDocSection(chunks[0].id, beyond, 10, chunks);
        assert.equal(end.text, '');
        assert.equal(end.start, body.length);
        assert.equal(end.nextOffset, null);
    }
    assert.equal(getDocSection('missing', 0, 10, chunks), null);
});

test('rejects invalid page and excerpt bounds and caps excerpt size', () => {
    const chunks = loadChunks(fixture(`## Bounds\n${'body '.repeat(4000)}`));
    for (const invalid of [-1, 0, 1.2, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => getDocExcerpt(chunks[0], 'body', invalid), RangeError);
        assert.throws(() => getDocSection(chunks[0].id, 0, invalid, chunks), RangeError);
    }
    for (const invalid of [-1, 1.2, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => getDocSection(chunks[0].id, invalid, 10, chunks), RangeError);
    }
    assert.equal(
        getDocExcerpt(chunks[0], 'body', Number.MAX_SAFE_INTEGER).text.length,
        MAX_EXCERPT_LENGTH
    );
    assert.equal(getDocSection(chunks[0].id, 1, 1, chunks).text, 'o');
});

test('no-match, heading-only, empty-section and missing-directory retrieval are deterministic', () => {
    const root = fixture('## HeadingOnly\nbody content\n## Empty');
    const chunks = loadChunks(root);
    assert.deepEqual(searchDocs('absentterm', 5, chunks), []);
    assert.deepEqual(searchDocs('! a', 5, chunks), []);
    assert.equal(searchDocs('headingonly', 5, chunks)[0].chunk.id, chunks[0].id);
    assert.deepEqual(getDocExcerpt(chunks[0], 'absentterm', 4), {
        text: 'body',
        start: 0,
        end: 4,
        totalLength: 12,
    });
    assert.equal(getDocExcerpt(chunks[0], 'headingonly').start, 0);
    assert.equal(getDocSection(chunks[1].id, 0, 10, chunks).nextOffset, null);
    assert.equal(getDocExcerpt(chunks[1], 'empty').text, '');
    assert.deepEqual(loadChunks(path.join(root, 'missing')), []);
});
