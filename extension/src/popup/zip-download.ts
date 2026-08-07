// zip-download.ts - Bundle page images with the Markdown file into a ZIP.

import { remark } from 'remark';

interface MdastNode {
    type: string;
    url?: string;
    alt?: string | null;
    children?: MdastNode[];
    position?: {
        start: { offset?: number | null };
        end: { offset?: number | null };
    };
}

export interface ImageRef {
    url: string;
    alt: string;
    start: number; // char offset of the full image node "![alt](url)"
    end: number;   // char offset just past the node
}

/** Parse the markdown and collect image nodes in document order. */
export function collectImageNodes(markdown: string): ImageRef[] {
    const tree = remark().parse(markdown) as unknown as MdastNode;
    const nodes: ImageRef[] = [];
    const walk = (node: MdastNode): void => {
        if (
            node.type === 'image' &&
            node.position?.start.offset != null &&
            node.position?.end.offset != null
        ) {
            nodes.push({
                url: node.url ?? '',
                alt: typeof node.alt === 'string' ? node.alt : '',
                start: node.position.start.offset,
                end: node.position.end.offset,
            });
        }
        node.children?.forEach(walk);
    };
    walk(tree);
    return nodes;
}

/** Derive a file extension from a URL or data: MIME type; fallback .png. */
function extensionFor(url: string): string {
    if (url.startsWith('data:')) {
        const match = url.match(/^data:image\/([a-zA-Z0-9.+-]+)/);
        if (match) {
            const type = match[1].toLowerCase();
            return type === 'jpeg' ? '.jpg' : `.${type}`;
        }
        return '.png';
    }
    try {
        const path = new URL(url).pathname;
        const match = path.match(/\.([a-zA-Z0-9]{1,5})$/);
        if (match) return `.${match[1].toLowerCase()}`;
    } catch {
        // invalid URL - fall through
    }
    return '.png';
}

/** Assign each unique URL a local path images/img-NNN.ext, in first-seen order. */
export function assignLocalPaths(urls: string[]): Map<string, string> {
    const seen = new Set<string>();
    const map = new Map<string, string>();
    let counter = 0;
    for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        counter += 1;
        map.set(url, `images/img-${String(counter).padStart(3, '0')}${extensionFor(url)}`);
    }
    return map;
}

function escapeAlt(alt: string): string {
    return alt.replace(/[[\]]/g, (c) => `\\${c}`);
}

/**
 * Rewrite image references to local paths using mdast positions.
 * Only image-node ranges change; all other text is preserved verbatim.
 */
export function rewriteImageReferences(markdown: string, mapping: Map<string, string>): string {
    const nodes = collectImageNodes(markdown);
    const parts: string[] = [];
    let cursor = 0;
    for (const node of nodes) {
        if (node.start < cursor) continue;
        const local = mapping.get(node.url);
        if (!local) continue;
        parts.push(markdown.slice(cursor, node.start));
        parts.push(`![${escapeAlt(node.alt)}](${local})`);
        cursor = node.end;
    }
    parts.push(markdown.slice(cursor));
    return parts.join('');
}
