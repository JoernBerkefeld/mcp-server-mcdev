/**
 * Retrieval over bundled wiki Markdown. Retrieved claims are not semantic endorsements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DocChunk {
    /** Stable within a file and heading, with an occurrence suffix for duplicates. */
    id: string;
    file: string;
    heading: string;
    /** Complete section body, without retrieval truncation. */
    body: string;
}

function packageRoot(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function bundledWikiDir(): string {
    return path.join(packageRoot(), 'bundled', 'wiki');
}

export function loadChunks(dir: string = bundledWikiDir()): DocChunk[] {
    if (!fs.existsSync(dir)) return [];

    const chunks: DocChunk[] = [];
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .toSorted();

    for (const file of files) {
        const full = path.join(dir, file);
        const text = fs.readFileSync(full, 'utf8').replaceAll('\r\n', '\n');
        const parts = text.split(/\n(?=#{2,3}\s+)/);
        const occurrences = new Map<string, number>();
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const lines = trimmed.split('\n');
            const first = lines[0] ?? '';
            const headingMatch = first.match(/^#{2,3}\s+(.+)/);
            const heading = headingMatch ? headingMatch[1].trim() : file.replace(/\.md$/, '');
            const body = headingMatch ? lines.slice(1).join('\n').trim() : trimmed;
            if (!body && !headingMatch) continue;

            const occurrence = (occurrences.get(heading) ?? 0) + 1;
            occurrences.set(heading, occurrence);
            const id = `${encodeURIComponent(file)}#${encodeURIComponent(heading)}#${occurrence}`;
            chunks.push({ id, file, heading, body });
        }
    }

    return chunks;
}

let cache: DocChunk[] | null = null;

export function getChunks(): DocChunk[] {
    if (!cache) cache = loadChunks();
    return cache;
}

/** Reset cache (tests). */
export function clearChunkCache(): void {
    cache = null;
}

export interface SearchHit {
    score: number;
    chunk: DocChunk;
}

function tokenize(q: string): string[] {
    return q
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((t) => t.length > 1);
}

export const MAX_EXCERPT_LENGTH = 2000;
export const MAX_SECTION_PAGE_LENGTH = 12000;

function boundedLength(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError('Length must be a positive safe integer.');
    }
    return Math.min(value, maximum);
}

export interface DocExcerpt {
    text: string;
    /** UTF-16 offsets into the complete section body; end is exclusive. */
    start: number;
    end: number;
    totalLength: number;
}

/**
 * Return a bounded window around the first body match, or the body start.
 * @param chunk - Complete source section.
 * @param query - Keywords to center the excerpt on.
 * @param limit - Requested character window, capped at MAX_EXCERPT_LENGTH.
 * @returns {DocExcerpt} Source text window with exclusive end offset.
 */
export function getDocExcerpt(chunk: DocChunk, query: string, limit = 420): DocExcerpt {
    const length = boundedLength(limit, MAX_EXCERPT_LENGTH);
    const body = chunk.body.toLowerCase();
    const positions = tokenize(query)
        .map((term) => body.indexOf(term))
        .filter((pos) => pos >= 0);
    const match = positions.length > 0 ? Math.min(...positions) : 0;
    const start = Math.max(0, Math.min(match - Math.floor(length / 2), chunk.body.length - length));
    const end = Math.min(chunk.body.length, start + length);
    return { text: chunk.body.slice(start, end), start, end, totalLength: chunk.body.length };
}

export interface DocSectionPage extends DocExcerpt {
    id: string;
    file: string;
    heading: string;
    /** Pass as the next offset; null indicates the end of the section. */
    nextOffset: number | null;
}

/**
 * Retrieve a section by its opaque stable id, in bounded UTF-16 character pages.
 * @param id - Opaque section identifier returned by search.
 * @param offset - Nonnegative character offset into the body.
 * @param limit - Requested page length, capped at MAX_SECTION_PAGE_LENGTH.
 * @param chunks - Source sections, defaulting to the bundled cache.
 * @returns {DocSectionPage | null} A page, or null when the identifier is unknown.
 */
export function getDocSection(
    id: string,
    offset = 0,
    limit = 4000,
    chunks: DocChunk[] = getChunks()
): DocSectionPage | null {
    const length = boundedLength(limit, MAX_SECTION_PAGE_LENGTH);
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new RangeError('Offset must be a nonnegative safe integer.');
    }
    const chunk = chunks.find((candidate) => candidate.id === id);
    if (!chunk) return null;
    const start = Math.min(offset, chunk.body.length);
    const end = Math.min(chunk.body.length, start + length);
    return {
        id: chunk.id,
        file: chunk.file,
        heading: chunk.heading,
        text: chunk.body.slice(start, end),
        start,
        end,
        totalLength: chunk.body.length,
        nextOffset: end < chunk.body.length ? end : null,
    };
}

/**
 * Rank complete sections by term overlap and heading/file bonuses.
 * @param query - Search keywords.
 * @param limit - Maximum result count, preserving the existing minimum of one.
 * @param chunks - Source sections, defaulting to the bundled cache.
 * @returns {SearchHit[]} Ranked hits retaining complete source sections.
 */
export function searchDocs(
    query: string,
    limit: number,
    chunks: DocChunk[] = getChunks()
): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const hits: SearchHit[] = [];
    for (const chunk of chunks) {
        const hay = `${chunk.heading}\n${chunk.body}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
            if (hay.includes(t)) score += 2;
            if (chunk.heading.toLowerCase().includes(t)) score += 3;
            if (chunk.file.toLowerCase().includes(t)) score += 1;
        }
        if (score > 0) hits.push({ score, chunk });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, limit));
}
