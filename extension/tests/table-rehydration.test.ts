import { describe, it, expect } from 'vitest';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import { rehydrateMarkdown } from '../src/skeleton/skeletonizer';

// Black-box checks that original page text containing Markdown syntax cannot
// break the table structure the backend produced once it is rehydrated.

interface MarkdownNode {
    type: string;
    value?: string;
    children?: MarkdownNode[];
}

function parse(markdown: string): MarkdownNode {
    return remark().use(remarkGfm).parse(markdown) as unknown as MarkdownNode;
}

function nodesOfType(node: MarkdownNode, type: string): MarkdownNode[] {
    return [node, ...(node.children ?? []).flatMap((child) => nodesOfType(child, type))]
        .filter((child) => child.type === type);
}

function cellText(cell: MarkdownNode): string {
    if (cell.type === 'html') return cell.value ?? '';
    if (cell.value !== undefined) return cell.value;
    return (cell.children ?? []).map(cellText).join('');
}

function tableCells(markdown: string): string[][] {
    const tables = nodesOfType(parse(markdown), 'table');
    expect(tables).toHaveLength(1);
    return (tables[0].children ?? []).map((row) => (row.children ?? []).map(cellText));
}

const HOSTILE_VALUES = [
    'a | b',
    '|',
    '\\|',
    '*not emphasis*',
    '**not strong**',
    '`not code`',
    '<br>',
    '<b>not html</b>',
    '[not a link](https://example.test)',
    '![not an image](x.png)',
    '# not a heading',
    '- not a list',
    '1. not a list',
    '> not a quote',
    '| --- |',
    '{{MDZ1}}',
    'trailing backslash \\',
    '~~not struck~~',
    'https://example.test/a_b_c',
    'café 😀 <&>',
];

describe('table rehydration with hostile cell text', () => {
    it.each(HOSTILE_VALUES)('keeps the table intact and the text literal for %j', (value) => {
        const skeleton = '| {{MDZ0}} | {{MDZ1}} |\n| --- | --- |\n| {{MDZ2}} | {{MDZ3}} |';
        const tokens = { '{{MDZ0}}': 'Header', '{{MDZ1}}': value, '{{MDZ2}}': value, '{{MDZ3}}': 'Plain' };

        expect(tableCells(rehydrateMarkdown(skeleton, tokens))).toEqual([
            ['Header', value],
            [value, 'Plain'],
        ]);
    });

    it('keeps converter <br> line breaks while literal <br> text stays text', () => {
        // Shape the backend emits for a flattened nested table cell.
        const skeleton = '| {{MDZ0}} | {{MDZ1}}<br>{{MDZ2}}<br>· <br>{{MDZ3}}<br>{{MDZ4}} |\n| --- | --- |\n| {{MDZ5}} | {{MDZ6}} |';
        const tokens = {
            '{{MDZ0}}': 'Criterion',
            '{{MDZ1}}': 'Poor <br> work',
            '{{MDZ2}}': '0 points',
            '{{MDZ3}}': 'Good | work',
            '{{MDZ4}}': '1 points',
            '{{MDZ5}}': 'Next',
            '{{MDZ6}}': 'Row',
        };

        const result = rehydrateMarkdown(skeleton, tokens);
        const htmlNodes = nodesOfType(parse(result), 'html').map((node) => node.value);

        expect(htmlNodes).toEqual(['<br>', '<br>', '<br>', '<br>']);
        expect(tableCells(result)).toEqual([
            ['Criterion', 'Poor <br> work<br>0 points<br>· <br>Good | work<br>1 points'],
            ['Next', 'Row'],
        ]);
    });

    it('keeps an empty header row for label/value tables', () => {
        const skeleton = '|  |  |\n| --- | --- |\n| {{MDZ0}} | {{MDZ1}} |\n| {{MDZ2}} | {{MDZ3}} |';
        const tokens = { '{{MDZ0}}': 'Status', '{{MDZ1}}': 'Open | blocked', '{{MDZ2}}': 'Owner', '{{MDZ3}}': '*Sam*' };

        expect(tableCells(rehydrateMarkdown(skeleton, tokens))).toEqual([
            ['', ''],
            ['Status', 'Open | blocked'],
            ['Owner', '*Sam*'],
        ]);
    });

    it('round-trips random hostile text through generated tables', () => {
        // Deterministic LCG so failures reproduce.
        let state = 42;
        const random = (n: number) => {
            state = (state * 1103515245 + 12345) % 2 ** 31;
            return state % n;
        };
        const alphabet = ['|', '\\', '*', '_', '`', '<', '>', '[', ']', '(', ')', '#', '-', '~', '!', '&', 'a', 'Z', '1', ' ', 'é'];
        const word = () => Array.from({ length: 1 + random(8) }, () => alphabet[random(alphabet.length)]).join('').trim() || 'x';

        for (let iteration = 0; iteration < 200; iteration++) {
            const columns = 1 + random(4);
            const rows = 1 + random(4);
            const tokens: Record<string, string> = {};
            const expected: string[][] = [];
            const lines: string[] = [];
            let next = 0;
            for (let row = 0; row < rows; row++) {
                const values = Array.from({ length: columns }, word);
                const ids = values.map((value) => {
                    const id = `{{MDZ${next++}}}`;
                    tokens[id] = value;
                    return id;
                });
                expected.push(values);
                lines.push(`| ${ids.join(' | ')} |`);
                if (row === 0) lines.push(`|${' --- |'.repeat(columns)}`);
            }

            const result = rehydrateMarkdown(lines.join('\n'), tokens);
            expect(tableCells(result), `iteration ${iteration}:\n${result}`).toEqual(expected);
        }
    });
});
