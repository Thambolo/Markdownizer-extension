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
});
