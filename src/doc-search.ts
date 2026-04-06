/**
 * Simple full-text search over bundled sfmc-devtools wiki Markdown files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DocChunk {
    /** Stable id for deduplication */
    id: string;
    /** Source file name */
    file: string;
    /** Section heading or file title */
    heading: string;
    body: string;
}

function packageRoot(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function bundledWikiDir(): string {
    return path.join(packageRoot(), 'bundled', 'wiki');
}

export function loadChunks(): DocChunk[] {
    const dir = bundledWikiDir();
    if (!fs.existsSync(dir)) return [];

    const chunks: DocChunk[] = [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
        const full = path.join(dir, file);
        const text = fs.readFileSync(full, 'utf8');
        const parts = text.split(/\n(?=#{2,3}\s+)/);
        let i = 0;
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const lines = trimmed.split('\n');
            const first = lines[0] ?? '';
            const headingMatch = first.match(/^#{2,3}\s+(.+)/);
            const heading = headingMatch ? headingMatch[1].trim() : file.replace(/\.md$/, '');
            const body = headingMatch ? lines.slice(1).join('\n').trim() : trimmed;
            if (!body && !headingMatch) continue;

            const id = `${file}#${i++}`;
            chunks.push({
                id,
                file,
                heading,
                body: body.length > 12000 ? `${body.slice(0, 12000)}\n\n…` : body,
            });
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

/**
 * Rank chunks by simple term overlap + heading bonus.
 */
export function searchDocs(query: string, limit: number): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const chunks = getChunks();
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
