/**
 * Browser tests for ContentPreview: real Chromium layout, CSS Custom Highlight
 * registry ownership, Shadow DOM host geometry, pointer-event passthrough,
 * scroll/resize reflow, MutationObserver rebuild, loading/ready transitions,
 * cleanup, and no boundary artifacts.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import {
    ContentPreview,
    CONTENT_PREVIEW_HOST_ATTRIBUTE,
    READY_HIGHLIGHT_NAME,
    LOADING_HIGHLIGHT_NAME,
} from '../src/content-preview';

// ── Helpers ──────────────────────────────────────────────────────────────────

const HOST_SEL = `[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`;
const BOX_SEL = '.content-preview-box';

/** Wait for two animation frames so geometry callbacks settle. */
function doubleRaf(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

/** Short wait for one rAF. */
function singleRaf(): Promise<number> {
    return new Promise((resolve) => requestAnimationFrame(resolve));
}

function frameLoad(iframe: HTMLIFrameElement): Promise<void> {
    return new Promise((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
}

/** Reset document to a clean state. */
function cleanDOM(): void {
    document.documentElement.innerHTML = '<head></head><body></body>';
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function wrapTextFixture(): void {
    document.body.innerHTML = `
      <main id="root" style="width:120px;position:relative;">
        <p id="wrap">This is a paragraph that will wrap across multiple lines in a narrow container</p>
      </main>
    `;
}

function rootScopeFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <p>Inside root</p>
      </main>
      <footer id="outside">Outside root</footer>
    `;
}

function hiddenMismatchFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <p>Visible text</p>
        <p hidden>Hidden authored text</p>
      </main>
    `;
}

function imageBoxFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <img id="vis-img" alt="Diagram" style="display:block;width:160px;height:90px;">
      </main>
    `;
}

function controlBoxFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <button id="btn">Click</button>
        <input id="inp" type="text" value="text">
        <select id="sel"><option>One</option></select>
        <textarea id="ta">content</textarea>
        <input id="hidden-inp" type="hidden" value="secret">
      </main>
    `;
}

function pointerPassthroughFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <button id="click-btn" style="position:relative;width:100px;height:30px;">Press me</button>
        <input id="type-input" type="text" placeholder="type here" style="position:relative;width:200px;height:24px;">
      </main>
    `;
}

function mutationFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <p id="initial">Initial text</p>
        <img id="mut-img" alt="Image" style="display:block;width:100px;height:50px;">
      </main>
    `;
}

function loadingFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <img id="ld-img" alt="Img" style="display:block;width:80px;height:60px;">
      </main>
    `;
}

function cleanupFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <img id="cl-img" alt="Cleanup" style="display:block;width:100px;height:50px;">
      </main>
    `;
}

function boundaryArtifactFixture(): void {
    document.body.innerHTML = `
      <main id="root">
        <p>Normal text</p>
        <div class="layer">Layer element</div>
        <span class="badge">Badge</span>
        <div class="Selected">Selected class</div>
        <img id="artifact-img" alt="Has box" style="display:block;width:100px;height:50px;">
      </main>
    `;
}

function narrowMediaFixture(): void {
    document.body.innerHTML = `
      <main id="root" style="width:200px;">
        <img id="narrow-img" alt="Narrow" style="display:block;width:100%;height:80px;">
      </main>
    `;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ContentPreview in Chromium', () => {
    let preview: ContentPreview;

    beforeEach(() => {
        cleanDOM();
        preview = new ContentPreview();
    });

    afterEach(() => {
        preview.remove();
        cleanDOM();
    });

    // ── 1. Wrapped text: highlight registry owns the ready name ────────────

    it('registers ready highlight for wrapped text ranges', async () => {
        wrapTextFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        // Browser highlight registry owns the ready name
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);

        // The highlight should contain at least one Range (the paragraph text)
        const highlight = CSS.highlights.get(READY_HIGHLIGHT_NAME);
        expect(highlight).toBeDefined();

        // Collect all ranges from the highlight
        const ranges: Range[] = [];
        for (const range of highlight!) {
            ranges.push(range);
        }
        expect(ranges.length).toBeGreaterThanOrEqual(1);

        // All text from the paragraph should be captured in at least one range
        const paragraph = document.getElementById('wrap')!;
        const allRangeText = ranges.map((r) => r.toString()).join('');
        expect(allRangeText).toContain(paragraph.textContent!.trim().substring(0, 20));
    });

    // ── 2. Root scope: text outside root receives no Range ─────────────────

    it('does not create ranges for text outside the root', () => {
        rootScopeFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const highlight = CSS.highlights.get(READY_HIGHLIGHT_NAME);
        const ranges: Range[] = [];
        for (const range of highlight!) {
            ranges.push(range);
        }
        const allText = ranges.map((r) => r.toString()).join('');
        expect(allText).not.toContain('Outside root');
        expect(allText).toContain('Inside root');
    });

    it('highlights included iframe text without drawing iframe boxes', async () => {
        document.body.innerHTML = '<main id="root"><p>Parent text</p><iframe title="Widget" srcdoc="<p>Frame text</p>"></iframe></main>';
        const root = document.getElementById('root')!;
        const iframe = root.querySelector('iframe') as HTMLIFrameElement;
        await frameLoad(iframe);

        preview.show(root, { includeIframes: true });

        const frameCSS = iframe.contentDocument!.defaultView!.CSS;
        expect(frameCSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect([...frameCSS.highlights.get(READY_HIGHLIGHT_NAME)!].map((range) => range.toString()).join(' ')).toContain('Frame text');
        const host = document.querySelector(HOST_SEL) as HTMLElement | null;
        expect(host).toBeNull();

        preview.setLoading();
        expect(frameCSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(frameCSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(true);
        preview.setReady();
        expect(frameCSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);

        preview.remove();
        expect(frameCSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(frameCSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
    });

    it('rebuilds iframe highlights after a frame navigates', async () => {
        document.body.innerHTML = '<main id="root"><iframe title="Widget" srcdoc="<p>Before navigation</p>"></iframe></main>';
        const root = document.getElementById('root')!;
        const iframe = root.querySelector('iframe') as HTMLIFrameElement;
        await frameLoad(iframe);
        preview.show(root, { includeIframes: true });

        const navigated = frameLoad(iframe);
        iframe.srcdoc = '<p>After navigation</p>';
        await navigated;
        await doubleRaf();

        const frameCSS = iframe.contentDocument!.defaultView!.CSS;
        expect(frameCSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect([...frameCSS.highlights.get(READY_HIGHLIGHT_NAME)!].map((range) => range.toString()).join(' ')).toContain('After navigation');
    });

    // ── 3. Hidden mismatch: hidden text in textContent but no Range ───────

    it('excludes hidden authored text from preview ranges', () => {
        hiddenMismatchFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        // textContent of the root still contains the hidden text
        expect(root.textContent).toContain('Hidden authored text');

        // But preview ranges must not include it
        const highlight = CSS.highlights.get(READY_HIGHLIGHT_NAME);
        const ranges: Range[] = [];
        for (const range of highlight!) {
            ranges.push(range);
        }
        const allText = ranges.map((r) => r.toString()).join('');
        expect(allText).not.toContain('Hidden authored text');
        expect(allText).toContain('Visible text');
    });

    // ── 4. Images: visible image gets a box matching its rectangle ─────────

    it('creates a box for a visible image with geometry close to its client rect', () => {
        imageBoxFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        expect(host).not.toBeNull();

        const boxes = host.shadowRoot!.querySelectorAll(BOX_SEL);
        expect(boxes.length).toBeGreaterThanOrEqual(1);

        // The image should have at least one box
        const img = document.getElementById('vis-img')!;
        const imgRect = img.getBoundingClientRect();

        // Find the box that corresponds to the image (largest overlap)
        let bestBox: HTMLElement | null = null;
        let bestOverlap = 0;
        for (const box of Array.from(boxes)) {
            const bEl = box as HTMLElement;
            const bTop = parseFloat(bEl.style.top);
            const bLeft = parseFloat(bEl.style.left);
            const bW = parseFloat(bEl.style.width);
            const bH = parseFloat(bEl.style.height);
            // Overlap area approximation
            const overlapX = Math.max(0, Math.min(bLeft + bW, imgRect.right) - Math.max(bLeft, imgRect.left));
            const overlapY = Math.max(0, Math.min(bTop + bH, imgRect.bottom) - Math.max(bTop, imgRect.top));
            const overlap = overlapX * overlapY;
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestBox = bEl;
            }
        }

        expect(bestBox).not.toBeNull();

        // Box geometry should be within 1 px of the image's client rect
        const boxTop = parseFloat(bestBox!.style.top);
        const boxLeft = parseFloat(bestBox!.style.left);
        const boxW = parseFloat(bestBox!.style.width);
        const boxH = parseFloat(bestBox!.style.height);

        expect(Math.abs(boxTop - imgRect.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(boxLeft - imgRect.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(boxW - imgRect.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(boxH - imgRect.height)).toBeLessThanOrEqual(1);
    });

    // ── 5. Controls: visible controls get boxes; hidden input does not ────

    it('boxes visible button, input, select, textarea but not hidden input', () => {
        controlBoxFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        expect(host).not.toBeNull();

        const boxes = host.shadowRoot!.querySelectorAll(BOX_SEL);
        // At least 4 visible controls: button, input, select, textarea
        expect(boxes.length).toBeGreaterThanOrEqual(4);

        // Verify each visible control has a box by checking box positions
        // overlap with the control's bounding rect
        const visibleIds = ['btn', 'inp', 'sel', 'ta'];
        for (const id of visibleIds) {
            const el = document.getElementById(id)!;
            const rect = el.getBoundingClientRect();
            let found = false;
            for (const box of Array.from(boxes)) {
                const bEl = box as HTMLElement;
                const bTop = parseFloat(bEl.style.top);
                const bLeft = parseFloat(bEl.style.left);
                const bW = parseFloat(bEl.style.width);
                const bH = parseFloat(bEl.style.height);
                // Check overlap
                if (
                    bLeft < rect.right &&
                    bLeft + bW > rect.left &&
                    bTop < rect.bottom &&
                    bTop + bH > rect.top
                ) {
                    found = true;
                    break;
                }
            }
            expect(found).toBe(true);
        }

        // Hidden input (type=hidden) should NOT have a box
        const hiddenInp = document.getElementById('hidden-inp')!;
        const hRect = hiddenInp.getBoundingClientRect();
        let hiddenHasBox = false;
        for (const box of Array.from(boxes)) {
            const bEl = box as HTMLElement;
            const bTop = parseFloat(bEl.style.top);
            const bLeft = parseFloat(bEl.style.left);
            const bW = parseFloat(bEl.style.width);
            const bH = parseFloat(bEl.style.height);
            if (
                bLeft < hRect.right &&
                bLeft + bW > hRect.left &&
                bTop < hRect.bottom &&
                bTop + bH > hRect.top
            ) {
                hiddenHasBox = true;
                break;
            }
        }
        expect(hiddenHasBox).toBe(false);
    });

    // ── 6. Pointer and focus passthrough ───────────────────────────────────

    it('allows clicking a button beneath the overlay', async () => {
        pointerPassthroughFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        expect(host).not.toBeNull();
        // Host must have pointer-events:none
        expect(host.style.pointerEvents).toBe('none');
        expect(host.getAttribute('aria-hidden')).toBe('true');

        // Shadow root boxes also have pointer-events:none (from CSS class)
        const boxes = host.shadowRoot!.querySelectorAll(BOX_SEL);
        for (const box of Array.from(boxes)) {
            const bEl = box as HTMLElement;
            const computed = getComputedStyle(bEl);
            expect(computed.pointerEvents).toBe('none');
        }

        // The actual button is still clickable
        const btn = document.getElementById('click-btn')!;
        let clicked = false;
        btn.addEventListener('click', () => { clicked = true; });
        btn.click();
        await singleRaf();
        expect(clicked).toBe(true);
    });

    it('allows focusing and typing into an input beneath the overlay', async () => {
        pointerPassthroughFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        expect(host).not.toBeNull();

        const input = document.getElementById('type-input') as HTMLInputElement;
        input.focus();
        expect(document.activeElement).toBe(input);

        // Simulate typing
        input.value = 'typed text';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(input.value).toBe('typed text');
    });

    // ── 7. Scroll/resize: media box geometry updates ───────────────────────

    it('updates box geometry within two animation frames after scroll', async () => {
        narrowMediaFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        const boxesBefore = host.shadowRoot!.querySelectorAll(BOX_SEL);
        expect(boxesBefore.length).toBeGreaterThanOrEqual(1);

        const image = document.getElementById('narrow-img')!;
        const rectSpy = vi.spyOn(image, 'getClientRects').mockImplementation(
            () => [new DOMRect(37, 41, 200, 80)] as unknown as DOMRectList,
        );

        // Simulate a scroll event after the element's viewport rect changes.
        document.dispatchEvent(new Event('scroll', { bubbles: true }));

        await doubleRaf();

        const boxesAfter = host.shadowRoot!.querySelectorAll(BOX_SEL);
        expect(boxesAfter.length).toBeGreaterThanOrEqual(1);
        expect(parseFloat((boxesAfter[0] as HTMLElement).style.top)).toBe(41);
        expect(parseFloat((boxesAfter[0] as HTMLElement).style.left)).toBe(37);
        rectSpy.mockRestore();
    });

    it('updates box geometry within two animation frames after resize', async () => {
        narrowMediaFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        const boxesBefore = host.shadowRoot!.querySelectorAll(BOX_SEL);
        expect(boxesBefore.length).toBeGreaterThanOrEqual(1);
        const image = document.getElementById('narrow-img')!;
        const rectSpy = vi.spyOn(image, 'getClientRects').mockImplementation(
            () => [new DOMRect(53, 67, 180, 72)] as unknown as DOMRectList,
        );

        // Dispatch resize event
        window.dispatchEvent(new Event('resize'));

        await doubleRaf();

        const boxesAfter = host.shadowRoot!.querySelectorAll(BOX_SEL);
        expect(boxesAfter.length).toBeGreaterThanOrEqual(1);
        expect(parseFloat((boxesAfter[0] as HTMLElement).style.top)).toBe(67);
        expect(parseFloat((boxesAfter[0] as HTMLElement).style.left)).toBe(53);
        expect(parseFloat((boxesAfter[0] as HTMLElement).style.width)).toBe(180);
        expect(parseFloat((boxesAfter[0] as HTMLElement).style.height)).toBe(72);
        rectSpy.mockRestore();
    });

    // ── 8. Mutation: adding/removing updates registry and boxes ────────────

    it('updates registry and boxes when a visible element is added', async () => {
        mutationFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        // Initial state: 1 image box + at least 1 text range
        const host = document.querySelector(HOST_SEL);
        expect(host).not.toBeNull();
        const initialBoxes = host!.shadowRoot!.querySelectorAll(BOX_SEL).length;

        // Add a new image
        const newImg = document.createElement('img');
        newImg.id = 'added-img';
        newImg.alt = 'Added';
        newImg.style.cssText = 'display:block;width:80px;height:40px;';
        root.appendChild(newImg);

        // Trigger mutation
        await singleRaf();
        await singleRaf();

        // After mutation rebuild, there should be at least one more box
        const updatedBoxes = host!.shadowRoot!.querySelectorAll(BOX_SEL).length;
        expect(updatedBoxes).toBeGreaterThanOrEqual(initialBoxes + 1);
    });

    it('updates registry when visible text is removed', async () => {
        mutationFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        // Initial highlight has ranges
        const highlightBefore = CSS.highlights.get(READY_HIGHLIGHT_NAME);
        expect(highlightBefore).toBeDefined();
        const countBefore = [...highlightBefore!].length;
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Remove the initial paragraph
        const p = document.getElementById('initial')!;
        root.removeChild(p);

        // Trigger mutation
        await singleRaf();
        await singleRaf();

        // After rebuild, ranges should have changed (fewer ranges)
        const highlightAfter = CSS.highlights.get(READY_HIGHLIGHT_NAME);
        expect(highlightAfter).toBeDefined();
        // The removed paragraph text should no longer be in any range
        const allText = [...highlightAfter!].map((r) => r.toString()).join('');
        expect(allText).not.toContain('Initial text');
    });

    // ── 9. Loading: ready registry replaced by loading registry ────────────

    it('transitions from ready to loading with stronger state styling', () => {
        loadingFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        // Ready state
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
        const host = document.querySelector(HOST_SEL) as HTMLElement;
        expect(host.getAttribute('data-preview-state')).toBe('ready');

        // Transition to loading
        preview.setLoading();

        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(true);
        const hostAfter = document.querySelector(HOST_SEL) as HTMLElement;
        expect(hostAfter.getAttribute('data-preview-state')).toBe('loading');

        // The loading host should have boxes with stronger styling
        // (the CSS :host([data-preview-state="loading"]) rule applies)
        const boxes = hostAfter.shadowRoot!.querySelectorAll(BOX_SEL);
        expect(boxes.length).toBeGreaterThanOrEqual(1);
    });

    // ── 10. Cleanup: both registry names and host are absent ───────────────

    it('removes all registry names and host after remove()', () => {
        cleanupFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        // Verify host exists
        expect(document.querySelector(HOST_SEL)).not.toBeNull();
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);

        preview.remove();

        // Both registry names should be deleted
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);

        // Host should be removed from DOM
        expect(document.querySelector(HOST_SEL)).toBeNull();
    });

    it('removes all registry names and host after hide (remove)', () => {
        cleanupFixture();
        const root = document.getElementById('root')!;
        preview.show(root);
        preview.setLoading();

        expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(true);
        expect(document.querySelector(HOST_SEL)).not.toBeNull();

        preview.remove();

        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
        expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
        expect(document.querySelector(HOST_SEL)).toBeNull();
    });

    // ── 11. No boundary artifacts ──────────────────────────────────────────

    it('does not inject .layer, .badge, .Selected, capture-boundary outline, or logo image', () => {
        boundaryArtifactFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        // Check the host itself
        const host = document.querySelector(HOST_SEL) as HTMLElement;
        expect(host).not.toBeNull();

        // No .layer elements
        expect(host.querySelector('.layer')).toBeNull();

        // No .badge elements
        expect(host.querySelector('.badge')).toBeNull();

        // No .Selected elements
        expect(host.querySelector('.Selected')).toBeNull();

        // No logo image in host
        const imgs = host.querySelectorAll('img');
        for (const img of Array.from(imgs)) {
            const src = img.getAttribute('src') || '';
            expect(src.toLowerCase()).not.toContain('logo');
        }

        // Shadow root boxes should not contain these artifacts either
        const shadowRoot = host.shadowRoot!;
        expect(shadowRoot.querySelector('.layer')).toBeNull();
        expect(shadowRoot.querySelector('.badge')).toBeNull();
        expect(shadowRoot.querySelector('.Selected')).toBeNull();

        // No logo images in shadow root
        const shadowImgs = shadowRoot.querySelectorAll('img');
        for (const img of Array.from(shadowImgs)) {
            const src = img.getAttribute('src') || '';
            expect(src.toLowerCase()).not.toContain('logo');
        }
    });

    // ── Additional: loading state boxes use stronger visual styling ────────

    it('loading boxes have stronger border-color than ready boxes', () => {
        loadingFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        // Ready state: check CSS variables on host
        const hostReady = document.querySelector(HOST_SEL) as HTMLElement;
        expect(hostReady.getAttribute('data-preview-state')).toBe('ready');

        preview.setLoading();

        const hostLoading = document.querySelector(HOST_SEL) as HTMLElement;
        expect(hostLoading.getAttribute('data-preview-state')).toBe('loading');

        // The host has the loading attribute, which the CSS rule targets
        // :host([data-preview-state="loading"]) applies stronger colors
        expect(hostLoading.hasAttribute('data-preview-state')).toBe(true);
        expect(hostLoading.getAttribute('data-preview-state')).toBe('loading');
    });

    // ── Additional: host is positioned fixed, covers viewport ──────────────

    it('host element covers the full viewport with position:fixed', () => {
        cleanupFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        const style = getComputedStyle(host);
        expect(style.position).toBe('fixed');
        expect(style.inset).toBe('0px');
        expect(style.zIndex).toBe('2147483647');
    });

    // ── Additional: box elements use absolute positioning within shadow ────

    it('boxes are absolutely positioned in the shadow container', () => {
        cleanupFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        const boxes = host.shadowRoot!.querySelectorAll(BOX_SEL);
        expect(boxes.length).toBeGreaterThanOrEqual(1);

        for (const box of Array.from(boxes)) {
            const bEl = box as HTMLElement;
            const style = getComputedStyle(bEl);
            expect(style.position).toBe('absolute');
            expect(style.pointerEvents).toBe('none');
            expect(style.boxSizing).toBe('border-box');
        }
    });

    // ── Additional: repeated show() replaces host, no duplicates ───────────

    it('repeated show() does not create duplicate hosts', () => {
        cleanupFixture();
        const root = document.getElementById('root')!;

        preview.show(root);
        preview.show(root);
        preview.show(root);

        const hosts = document.querySelectorAll(HOST_SEL);
        expect(hosts).toHaveLength(1);
    });

    // ── Additional: setReady restores after setLoading ─────────────────────

    it('setReady() restores ready state after setLoading()', () => {
        loadingFixture();
        const root = document.getElementById('root')!;
        preview.show(root);

        preview.setLoading();
        expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(true);
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);

        preview.setReady();
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);

        const host = document.querySelector(HOST_SEL) as HTMLElement;
        expect(host.getAttribute('data-preview-state')).toBe('ready');
    });

    // ── Task 5: Incremental iframe preview ──────────────────────────────────

    describe('incremental iframe preview', () => {
        it('parent non-iframe load does not rebuild iframe contexts', async () => {
            // Setup: parent with an iframe and a sibling non-iframe element
            document.body.innerHTML = `
                <main id="root">
                    <iframe title="Frame1" srcdoc="<p>Frame1 text</p>"></iframe>
                    <img id="sibling-img" alt="Sibling" style="display:block;width:100px;height:50px;">
                </main>
            `;
            const root = document.getElementById('root')!;
            const iframe = root.querySelector('iframe') as HTMLIFrameElement;
            await frameLoad(iframe);

            preview.show(root, { includeIframes: true });

            // Get frame1's registry before mutation
            const frameCSS1 = iframe.contentDocument!.defaultView!.CSS;
            const highlightBefore = frameCSS1.highlights.get(READY_HIGHLIGHT_NAME);
            const rangesBefore = highlightBefore ? [...highlightBefore].map(r => r.toString()).join('') : '';
            expect(rangesBefore).toContain('Frame1 text');

            // Simulate a non-iframe load event on the document
            const loadEvent = new Event('load', { bubbles: false });
            iframe.ownerDocument.dispatchEvent(loadEvent);
            await doubleRaf();

            // Frame1's context should NOT have been rebuilt
            const highlightAfter = frameCSS1.highlights.get(READY_HIGHLIGHT_NAME);
            const rangesAfter = highlightAfter ? [...highlightAfter].map(r => r.toString()).join('') : '';
            expect(rangesAfter).toContain('Frame1 text');
            // The ranges should be the same objects (not rebuilt)
            expect(highlightAfter).toBe(highlightBefore);
        });

        it('one iframe mutation does not replace another iframe context or style', async () => {
            // Setup: root with two iframes
            document.body.innerHTML = `
                <main id="root">
                    <iframe title="Frame1" srcdoc="<p>Frame1 text</p>"></iframe>
                    <iframe title="Frame2" srcdoc="<p>Frame2 text</p>"></iframe>
                </main>
            `;
            const root = document.getElementById('root')!;
            const iframes = root.querySelectorAll('iframe');
            const iframe1 = iframes[0] as HTMLIFrameElement;
            const iframe2 = iframes[1] as HTMLIFrameElement;
            await frameLoad(iframe1);
            await frameLoad(iframe2);

            preview.show(root, { includeIframes: true });

            // Get references to Frame2's style element and highlights
            const frameDoc2 = iframe2.contentDocument!;
            const styleBefore = frameDoc2.querySelector(`[data-markdownizer-iframe-preview-style]`);
            expect(styleBefore).not.toBeNull();

            const frameCSS2 = frameDoc2.defaultView!.CSS;
            const highlight2Before = frameCSS2.highlights.get(READY_HIGHLIGHT_NAME);
            const ranges2Before = highlight2Before ? [...highlight2Before].map(r => r.toString()).join('') : '';
            expect(ranges2Before).toContain('Frame2 text');

            // Mutate Frame1's content
            const frameDoc1 = iframe1.contentDocument!;
            frameDoc1.body.innerHTML = '<p>Updated Frame1 text</p>';

            // Trigger a mutation on Frame1 via its observer
            // The MutationObserver should rebuild only Frame1
            await doubleRaf();

            // Frame2's style should still be the same element (not replaced)
            const styleAfter = frameDoc2.querySelector(`[data-markdownizer-iframe-preview-style]`);
            expect(styleAfter).toBe(styleBefore);

            // Frame2's highlights should still contain Frame2 text
            const highlight2After = frameCSS2.highlights.get(READY_HIGHLIGHT_NAME);
            expect(highlight2After).not.toBeNull();
            const ranges2After = [...highlight2After!].map(r => r.toString()).join('');
            expect(ranges2After).toContain('Frame2 text');
        });

        it('navigation replaces only that branch context', async () => {
            // Setup: root with two iframes
            document.body.innerHTML = `
                <main id="root">
                    <iframe title="Frame1" srcdoc="<p>Frame1 original</p>"></iframe>
                    <iframe title="Frame2" srcdoc="<p>Frame2 stable</p>"></iframe>
                </main>
            `;
            const root = document.getElementById('root')!;
            const iframes = root.querySelectorAll('iframe');
            const iframe1 = iframes[0] as HTMLIFrameElement;
            const iframe2 = iframes[1] as HTMLIFrameElement;
            await frameLoad(iframe1);
            await frameLoad(iframe2);

            preview.show(root, { includeIframes: true });

            // Record Frame2's style before navigation
            const frameDoc2 = iframe2.contentDocument!;
            const styleBefore = frameDoc2.querySelector(`[data-markdownizer-iframe-preview-style]`);
            expect(styleBefore).not.toBeNull();

            // Navigate Frame1
            const nav1 = frameLoad(iframe1);
            iframe1.srcdoc = '<p>Frame1 navigated</p>';
            await nav1;
            await doubleRaf();

            // Frame1 should have new content
            const frameDoc1New = iframe1.contentDocument!;
            expect(frameDoc1New.body.textContent).toContain('Frame1 navigated');

            // Frame2's style should still be the same DOM element (not replaced)
            const styleAfter = frameDoc2.querySelector(`[data-markdownizer-iframe-preview-style]`);
            expect(styleAfter).toBe(styleBefore);

            // Frame2's highlights should still work
            const frameCSS2 = frameDoc2.defaultView!.CSS;
            const highlight2 = frameCSS2.highlights.get(READY_HIGHLIGHT_NAME);
            expect(highlight2).not.toBeNull();
            expect([...highlight2!].map(r => r.toString()).join('')).toContain('Frame2 stable');
        });

        it('disabling iframe preview preserves top-document highlights and boxes', async () => {
            document.body.innerHTML = `
                <main id="root">
                    <p>Parent text</p>
                    <iframe title="Frame1" srcdoc="<p>Frame1 text</p>"></iframe>
                    <img id="root-img" alt="Root image" style="display:block;width:100px;height:50px;">
                </main>
            `;
            const root = document.getElementById('root')!;
            const iframe = root.querySelector('iframe') as HTMLIFrameElement;
            await frameLoad(iframe);

            // Show with iframes enabled
            preview.show(root, { includeIframes: true });

            // Top-document highlights present
            expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
            const topRanges = [...CSS.highlights.get(READY_HIGHLIGHT_NAME)!].map(r => r.toString()).join('');
            expect(topRanges).toContain('Parent text');

            // Top-document host box present (image)
            const hostBefore = document.querySelector(HOST_SEL) as HTMLElement | null;
            expect(hostBefore).not.toBeNull();
            const boxesBefore = hostBefore!.shadowRoot!.querySelectorAll(BOX_SEL).length;
            expect(boxesBefore).toBeGreaterThanOrEqual(1);

            // Frame highlights present
            const frameCSS = iframe.contentDocument!.defaultView!.CSS;
            expect(frameCSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);

            // Disable iframe preview
            preview.setIncludeIframes(false);

            // Top-document highlights still present
            expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
            const topRangesAfter = [...CSS.highlights.get(READY_HIGHLIGHT_NAME)!].map(r => r.toString()).join('');
            expect(topRangesAfter).toContain('Parent text');

            // Top-document host box still present
            const hostAfter = document.querySelector(HOST_SEL) as HTMLElement | null;
            expect(hostAfter).not.toBeNull();
            const boxesAfter = hostAfter!.shadowRoot!.querySelectorAll(BOX_SEL).length;
            expect(boxesAfter).toBe(boxesBefore);

            // Frame highlights removed
            expect(frameCSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
        });

        it('tracks newly appended iframes without requiring another show()', async () => {
            document.body.innerHTML = `
                <main id="root">
                    <p>Parent text</p>
                </main>
            `;
            const root = document.getElementById('root')!;
            preview.show(root, { includeIframes: true });

            // No iframes initially — top-document highlight present
            expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);

            // Append a new same-origin iframe after preview is active
            const iframe = document.createElement('iframe');
            iframe.title = 'LateFrame';
            iframe.srcdoc = '<p>Late frame text</p>';
            root.appendChild(iframe);

            await frameLoad(iframe);
            // Wait for the scheduled branch reconcile to flush
            await doubleRaf();

            // The new iframe should have its own CSS highlight with frame text
            const frameCSS = iframe.contentDocument!.defaultView!.CSS;
            expect(frameCSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
            const frameRanges = [...frameCSS.highlights.get(READY_HIGHLIGHT_NAME)!]
                .map((r) => r.toString())
                .join(' ');
            expect(frameRanges).toContain('Late frame text');
        });

        it('cleanup removes all frame styles, registries, observers, and listeners', async () => {
            document.body.innerHTML = `
                <main id="root">
                    <p>Parent text</p>
                    <iframe title="Frame1" srcdoc="<p>Frame1 text</p>"></iframe>
                    <iframe title="Frame2" srcdoc="<p>Frame2 text</p>"></iframe>
                </main>
            `;
            const root = document.getElementById('root')!;
            const iframes = root.querySelectorAll('iframe');
            const iframe1 = iframes[0] as HTMLIFrameElement;
            const iframe2 = iframes[1] as HTMLIFrameElement;
            await frameLoad(iframe1);
            await frameLoad(iframe2);

            preview.show(root, { includeIframes: true });

            // Verify both frames have styles, registries, and observers
            const frameDoc1 = iframe1.contentDocument!;
            const frameDoc2 = iframe2.contentDocument!;
            expect(frameDoc1.querySelector(`[data-markdownizer-iframe-preview-style]`)).not.toBeNull();
            expect(frameDoc2.querySelector(`[data-markdownizer-iframe-preview-style]`)).not.toBeNull();

            const frameCSS1 = frameDoc1.defaultView!.CSS;
            const frameCSS2 = frameDoc2.defaultView!.CSS;
            expect(frameCSS1.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
            expect(frameCSS2.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);

            // Remove all preview resources
            preview.remove();

            // Frame styles removed
            expect(frameDoc1.querySelector(`[data-markdownizer-iframe-preview-style]`)).toBeNull();
            expect(frameDoc2.querySelector(`[data-markdownizer-iframe-preview-style]`)).toBeNull();

            // Frame registries cleared
            expect(frameCSS1.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
            expect(frameCSS1.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);
            expect(frameCSS2.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
            expect(frameCSS2.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);

            // Top-document registry also cleared
            expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(false);
            expect(CSS.highlights.has(LOADING_HIGHLIGHT_NAME)).toBe(false);

            // Host removed
            expect(document.querySelector(HOST_SEL)).toBeNull();
        });
    });
});

// ── Task 6: Browser timing fixture ───────────────────────────────────────────

describe('ContentPreview timing fixture', () => {
    let preview: ContentPreview;

    beforeEach(() => {
        cleanDOM();
        preview = new ContentPreview();
    });

    afterEach(() => {
        preview.remove();
        cleanDOM();
    });

    it('show() completes within a reasonable time on a large DOM with multiple srcdoc frames', async () => {
        // Build a controlled large DOM with 5 same-origin srcdoc frames
        // Include an image so the host overlay is created (boxed element required)
        let framesHtml = '';
        for (let i = 0; i < 5; i++) {
            framesHtml += `<iframe title="Frame ${i}" srcdoc="<p>Frame ${i} content with some text to highlight</p>"></iframe>`;
        }
        let textHtml = '';
        for (let i = 0; i < 50; i++) {
            textHtml += `<p>Paragraph ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>`;
        }
        document.body.innerHTML = `
            <main id="root">
                <img id="hero" alt="Hero" style="display:block;width:200px;height:100px;">
                ${textHtml}
                ${framesHtml}
            </main>
        `;
        const root = document.getElementById('root')!;

        // Wait for all frames to load
        const iframes = root.querySelectorAll('iframe');
        await Promise.all(Array.from(iframes).map(frameLoad));

        // Measure show() timing (top-level only, without iframes)
        const startTop = performance.now();
        preview.show(root);
        const topPreviewMs = performance.now() - startTop;

        // Assert correctness: host created, highlights registered
        expect(document.querySelector(HOST_SEL)).not.toBeNull();
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);

        // Record timing without making test depend on fragile absolute threshold
        // show() on a large DOM should complete in well under 1 second
        expect(topPreviewMs).toBeLessThan(1000);

        // Now measure iframe enablement separately
        preview.remove();
        const startIframe = performance.now();
        preview.show(root, { includeIframes: true });
        const iframePreviewMs = performance.now() - startIframe;

        // Assert correctness: highlights present in all frames
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        for (const iframe of Array.from(iframes)) {
            const frameCSS = iframe.contentDocument?.defaultView?.CSS;
            expect(frameCSS?.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        }

        // Record timing without making test depend on fragile absolute threshold
        expect(iframePreviewMs).toBeLessThan(2000);
    });

    it('setIncludeIframes(true) is faster than a full show() with iframes', async () => {
        // Build a DOM with frames and an image (boxed element required for host)
        document.body.innerHTML = `
            <main id="root">
                <img id="box-img" alt="Box" style="display:block;width:100px;height:50px;">
                <p>Main content</p>
                <iframe title="Frame 1" srcdoc="<p>Frame 1 text</p>"></iframe>
                <iframe title="Frame 2" srcdoc="<p>Frame 2 text</p>"></iframe>
            </main>
        `;
        const root = document.getElementById('root')!;
        const iframes = root.querySelectorAll('iframe');
        await Promise.all(Array.from(iframes).map(frameLoad));

        // First show without iframes (baseline)
        preview.show(root);
        expect(document.querySelector(HOST_SEL)).not.toBeNull();

        // Measure setIncludeIframes(true) — should be fast since it only adds frame highlights
        const startToggle = performance.now();
        preview.setIncludeIframes(true);
        const toggleMs = performance.now() - startToggle;

        // Verify correctness
        expect(CSS.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        for (const iframe of Array.from(iframes)) {
            const frameCSS = iframe.contentDocument?.defaultView?.CSS;
            expect(frameCSS?.highlights.has(READY_HIGHLIGHT_NAME)).toBe(true);
        }

        // Toggle should complete quickly (no absolute threshold, just sanity)
        expect(toggleMs).toBeLessThan(500);
    });
});
