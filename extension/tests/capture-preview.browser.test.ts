import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, cdp, userEvent } from 'vitest/browser';
import { CapturePreview, PREVIEW_HOST_ATTRIBUTE } from '../src/capture-preview';

const testStyles: HTMLStyleElement[] = [];

function addStyle(css: string): void {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    testStyles.push(style);
}

/** Wait for two animation frames so the controller can schedule + flush. */
function waitForTwoFrames(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
        });
    });
}

let preview: CapturePreview;

beforeEach(() => {
    preview = new CapturePreview();
});

afterEach(() => {
    preview.remove();
    document.body.replaceChildren();
    document.documentElement.style.cssText = '';
    testStyles.splice(0).forEach((s) => s.remove());
});

// ── Geometry ────────────────────────────────────────────────────────────────

describe('overlay geometry in Chromium', () => {
    it('matches the target element boundary within one CSS pixel', async () => {
        const main = document.createElement('main');
        Object.assign(main.style, {
            position: 'absolute',
            top: '120px',
            left: '80px',
            width: '400px',
            height: '250px',
        });
        document.body.appendChild(main);

        preview.show(main);
        await waitForTwoFrames();

        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`) as HTMLElement;
        const hostLayer = host.shadowRoot!.querySelector('.layer') as HTMLDivElement;
        const rect = main.getBoundingClientRect();
        const style = hostLayer.style;

        expect(Math.abs(parseFloat(style.top) - rect.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(parseFloat(style.left) - rect.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(parseFloat(style.width) - rect.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(parseFloat(style.height) - rect.height)).toBeLessThanOrEqual(1);
    });

    it('updates after scroll and resize within two animation frames', async () => {
        // Make body tall enough to scroll
        const spacer = document.createElement('div');
        spacer.style.height = '2000px';
        document.body.appendChild(spacer);

        const main = document.createElement('main');
        Object.assign(main.style, {
            position: 'absolute',
            top: '100px',
            left: '50px',
            width: '300px',
            height: '200px',
        });
        document.body.appendChild(main);

        preview.show(main);
        await waitForTwoFrames();

        // Scroll the page
        window.scrollTo(0, 300);
        // Resize the viewport
        await page.viewport(800, 600);

        await waitForTwoFrames();

        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`) as HTMLElement;
        const hostLayer = host.shadowRoot!.querySelector('.layer') as HTMLDivElement;
        const rect = main.getBoundingClientRect();
        const style = hostLayer.style;

        expect(Math.abs(parseFloat(style.top) - rect.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(parseFloat(style.left) - rect.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(parseFloat(style.width) - rect.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(parseFloat(style.height) - rect.height)).toBeLessThanOrEqual(1);
    });
});

// ── Style isolation ─────────────────────────────────────────────────────────

describe('Shadow DOM style isolation in Chromium', () => {
    it('layer properties remain governed by shadow styles despite hostile page rules', async () => {
        // Add hostile page CSS rules targeting div, *, and the host marker
        addStyle(`
            * { visibility: hidden !important; }
            div { display: none !important; }
            [${PREVIEW_HOST_ATTRIBUTE}] { opacity: 0 !important; }
        `);

        const main = document.createElement('main');
        main.textContent = 'Content';
        document.body.appendChild(main);

        preview.show(main);
        await waitForTwoFrames();

        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`) as HTMLElement;
        const hostLayer = host.shadowRoot!.querySelector('.layer') as HTMLDivElement;

        // The layer is inside the shadow root so external selectors cannot
        // reach it directly. Non-inherited properties set in the shadow
        // stylesheet must be preserved.
        const layerStyle = getComputedStyle(hostLayer);
        expect(layerStyle.position).toBe('absolute');
        expect(layerStyle.pointerEvents).toBe('none');
        expect(layerStyle.boxSizing).toBe('border-box');

        // Verify the shadow outline color survived (explicitly set in shadow styles)
        expect(layerStyle.outlineColor).toBe('rgb(99, 102, 241)');
    });
});

// ── Pointer-events passthrough ──────────────────────────────────────────────

describe('pointer-events passthrough in Chromium', () => {
    it('allows clicks to reach elements beneath the overlay', async () => {
        const main = document.createElement('main');
        Object.assign(main.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '400px',
            height: '300px',
        });
        document.body.appendChild(main);

        let clicked = false;
        const btn = document.createElement('button');
        btn.textContent = 'Click me';
        btn.addEventListener('click', () => { clicked = true; });
        main.appendChild(btn);

        preview.show(main);
        await waitForTwoFrames();

        // The overlay layer has pointer-events: none, so the click should pass through
        await userEvent.click(btn);

        expect(clicked).toBe(true);
    });
});

// ── Loading state ───────────────────────────────────────────────────────────

describe('loading state in Chromium', () => {
    it('does not change the page element dimensions when loading', async () => {
        const main = document.createElement('main');
        Object.assign(main.style, {
            position: 'absolute',
            top: '50px',
            left: '50px',
            width: '350px',
            height: '180px',
        });
        document.body.appendChild(main);

        preview.show(main);
        await waitForTwoFrames();

        const before = main.getBoundingClientRect();

        preview.setLoading();
        await waitForTwoFrames();

        const after = main.getBoundingClientRect();

        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        expect(after.top).toBe(before.top);
        expect(after.left).toBe(before.left);
    });
});

// ── Reduced motion ──────────────────────────────────────────────────────────

describe('reduced motion in Chromium', () => {
    it('has no animation when prefers-reduced-motion is reduce', async () => {
        const main = document.createElement('main');
        Object.assign(main.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100px',
            height: '100px',
        });
        document.body.appendChild(main);

        preview.show(main);
        await waitForTwoFrames();

        // Emulate reduced motion via CDP
        const session = cdp();
        await session.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });

        preview.setLoading();
        await waitForTwoFrames();

        const host = document.querySelector(`[${PREVIEW_HOST_ATTRIBUTE}]`) as HTMLElement;
        const hostLayer = host.shadowRoot!.querySelector('.layer') as HTMLDivElement;
        const computed = getComputedStyle(hostLayer);

        expect(computed.animationName).toBe('none');

        // Clean up media emulation
        await session.send('Emulation.setEmulatedMedia', { features: [] });
    });
});
