// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ARTICLE_PAGE, BODY_PAGE, EMPTY_PAGE, loadFixture } from './helpers/fixtures';
import { skeletonize } from '../src/skeleton/skeletonizer';

type RuntimeMessageListener = (
    request: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
) => boolean | undefined;

// Queue of forced shouldUseReadability decisions; empty = real size logic.
const { sizeDecisions } = vi.hoisted(() => ({ sizeDecisions: [] as boolean[] }));
// Mock for the readability fallback so the chain is deterministic in jsdom.
const { getReadabilityContentMock } = vi.hoisted(() => ({ getReadabilityContentMock: vi.fn() }));

vi.mock('../src/content/payload', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/content/payload')>();
    return {
        ...actual,
        shouldUseReadability: (html: string) => {
            if (sizeDecisions.length > 0) return sizeDecisions.shift()!;
            return actual.shouldUseReadability(html);
        },
    };
});

vi.mock('../src/extraction/extractor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/extraction/extractor')>();
    return { ...actual, getReadabilityContent: getReadabilityContentMock };
});

let listener: RuntimeMessageListener | undefined;
let sendMessageMock: ReturnType<typeof vi.fn>;

function setupDom(html: string): void {
    document.documentElement.innerHTML = html;
}

function convert(captureMode: string, includeIframes = false): Promise<unknown> {
    return new Promise((resolve) => {
        const keep = listener!({ action: 'convert_page', captureMode, includeIframes }, {}, resolve);
        expect(keep).toBe(true);
    });
}

function skeletonCall(): { action: string; payload: Record<string, unknown> } {
    const call = sendMessageMock.mock.calls.find(
        (c: unknown[]) => (c[0] as { action?: string }).action === 'convert_skeleton',
    );
    expect(call).toBeDefined();
    return call![0] as { action: string; payload: Record<string, unknown> };
}

describe('Conversion pipeline (processPage)', () => {
    beforeEach(async () => {
        vi.resetModules();
        sizeDecisions.length = 0;
        getReadabilityContentMock.mockReset();
        listener = undefined;
        sendMessageMock = vi.fn(async (message: unknown) => {
            const msg = message as { action?: string };
            if (msg.action === 'convert_skeleton') {
                return { success: true, markdown_skeleton: '# {{MDZ0}}' };
            }
            return { success: false };
        });
        (globalThis as unknown as { chrome: unknown }).chrome = {
            runtime: {
                onMessage: {
                    addListener: vi.fn((l: RuntimeMessageListener) => {
                        listener = l;
                    }),
                },
                onConnect: { addListener: vi.fn() },
                sendMessage: sendMessageMock,
            },
        };
        await import('../src/content/index');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as unknown as { chrome?: unknown }).chrome;
    });

    it('smart mode extracts the semantic article and reports strategy semantic-html', async () => {
        setupDom(ARTICLE_PAGE.html);
        const response = await convert('smart');
        expect(response).toMatchObject({ success: true });
        expect(skeletonCall().payload).toMatchObject({ extraction_strategy: 'semantic-html' });
    });

    it('smart mode falls back to visible body when no semantic landmarks exist', async () => {
        setupDom(BODY_PAGE.html);
        const response = await convert('smart');
        expect(response).toMatchObject({ success: true });
        expect(skeletonCall().payload).toMatchObject({ extraction_strategy: 'visible-body' });
    });

    it('smart mode falls back to Readability when the skeleton exceeds the size limit', async () => {
        setupDom(ARTICLE_PAGE.html);
        // processPage calls shouldUseReadability on the ORIGINAL skeleton three
        // times: line 367 (full-page guard, evaluated even in smart mode),
        // line 371 (smart fallback check), line 378 (post-fallback final check
        // on the NEW skeleton). Queue: true (full-page guard passes through),
        // true (fallback triggers), false (final check passes).
        sizeDecisions.push(true, true, false);
        const fallbackElement = document.querySelector('article')!;
        getReadabilityContentMock.mockReturnValue({ element: fallbackElement, strategy: 'readability' });

        const response = await convert('smart');
        expect(response).toMatchObject({ success: true });
        expect(getReadabilityContentMock).toHaveBeenCalledTimes(1);
        expect(skeletonCall().payload).toMatchObject({ extraction_strategy: 'readability' });
    });

    it('smart mode errors when even Readability output is too large', async () => {
        setupDom(ARTICLE_PAGE.html);
        // Same three calls: full-page guard true, fallback check true, final
        // check on the re-skeletonized output true → 'This page is too large'.
        sizeDecisions.push(true, true, true);
        getReadabilityContentMock.mockReturnValue({ element: document.querySelector('article')!, strategy: 'readability' });

        const response = await convert('smart');
        expect(response).toEqual({ success: false, error: 'This page is too large to convert.' });
    });

    it('full-page mode extracts the visible body', async () => {
        setupDom(ARTICLE_PAGE.html);
        const response = await convert('full-page');
        expect(response).toMatchObject({ success: true });
        expect(skeletonCall().payload).toMatchObject({ extraction_strategy: 'visible-body' });
    });

    it('full-page mode errors when the skeleton exceeds the size limit', async () => {
        setupDom(ARTICLE_PAGE.html);
        sizeDecisions.push(true);
        const response = await convert('full-page');
        expect(response).toEqual({
            success: false,
            error: 'The full page is too large to convert. Turn off Capture full page to use Smart selection.',
        });
    });

    it('include-iframes requests a CodeMirror capture and errors when combined content is too large', async () => {
        setupDom(ARTICLE_PAGE.html);
        sizeDecisions.push(true);
        const response = await convert('smart', true);
        expect(sendMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'read_codemirror_capture' }),
        );
        expect(response).toEqual({
            success: false,
            error: 'The page and included iframe content are too large to convert. Turn off Include iframes and try again.',
        });
    });

    it('throws when no visible content can be found', async () => {
        setupDom(EMPTY_PAGE.html);
        const response = await convert('smart');
        expect(response).toEqual({ success: false, error: 'Could not find visible page content.' });
    });

    it('rehydrates the markdown skeleton with local tokens', async () => {
        setupDom(ARTICLE_PAGE.html);
        const response = (await convert('smart')) as { success: boolean; markdown: string };
        expect(response.success).toBe(true);
        expect(response.markdown).toContain('# Characterization Article');
    });

    it('replaces CodeMirror editors with code blocks during extraction', async () => {
        setupDom(await loadFixture('codemirror-page'));
        const cm = document.querySelector('.CodeMirror') as unknown as {
            CodeMirror?: { getValue?: () => unknown };
        };
        cm.CodeMirror = { getValue: () => 'const a = 1;\nconst b = 2;' };

        const { getContentForMode } = await import('../src/extraction/extractor');
        const extraction = getContentForMode('smart');
        expect(extraction).not.toBeNull();
        const { html, tokens } = skeletonize(extraction!.element);
        expect(html).toContain('<pre>');
        expect(Object.values(tokens)).toContain('const a = 1;');
        expect(Object.values(tokens)).toContain('const b = 2;');
    });
});
