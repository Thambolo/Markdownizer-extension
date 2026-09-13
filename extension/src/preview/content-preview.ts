import { LOADING_HIGHLIGHT_NAME, READY_HIGHLIGHT_NAME } from './preview-highlights';
import { HighlightService, getHighlightConstructor, getHighlightRegistry } from './highlight-service';
import { BOXED_ANCESTORS, collectVisibleTextRanges, hasNonEmptyRect } from '../shared/dom-traversal';
import { IframeTextPreview } from './iframe-preview';

export const CONTENT_PREVIEW_HOST_ATTRIBUTE = 'data-markdownizer-content-preview-host';
export { LOADING_HIGHLIGHT_NAME, READY_HIGHLIGHT_NAME } from './preview-highlights';

/**
 * ContentPreview manages the lifecycle of CSS Custom Highlight overlays
 * for the markdownizer content preview, plus an optional host overlay that
 * renders `.content-preview-box` rectangles over visible boxed elements.
 */
export class ContentPreview {
    private textRanges: Range[] = [];
    private boxedElements: HTMLElement[] = [];
    private state: 'ready' | 'loading' = 'ready';
    private highlights = new HighlightService(
        getHighlightRegistry(),
        getHighlightConstructor(),
        READY_HIGHLIGHT_NAME,
        LOADING_HIGHLIGHT_NAME,
    );

    // ── Host overlay state ──────────────────────────────────────────────────
    private host: HTMLElement | null = null;
    private rootRef: HTMLElement | null = null;
    private containerRef: HTMLElement | null = null;
    private scrollHandler: (() => void) | null = null;
    private resizeHandler: (() => void) | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private rafId: number = 0;

    // ── MutationObserver state ──────────────────────────────────────────────
    private mutationObserver: MutationObserver | null = null;
    private rebuildPending: boolean = false;
    private iframePreview = new IframeTextPreview();
    private includeIframes = false;

    /**
     * Show the content preview for the given root element.
     * Calls remove() first to clear any stale state, then collects targets
     * and registers a ready highlight. When boxed elements exist, creates
     * an isolated host overlay with `.content-preview-box` rectangles.
     */
    show(root: HTMLElement, options: { includeIframes?: boolean } = {}): void {
        this.remove();
        this.rootRef = root;
        this.includeIframes = options.includeIframes === true;
        const targets = collectContentPreviewTargets(root);
        this.textRanges = targets.textRanges;
        this.boxedElements = targets.boxedElements;
        this.state = 'ready';

        this.highlights.setState('ready', this.textRanges);

        // Create host overlay only when boxed elements exist
        if (this.boxedElements.length > 0) {
            this.createHost(root);
            this.updateBoxes();
        }

        if (this.includeIframes) this.iframePreview.show(root);

        // Observe the selected root for mutations (not the host)
        this.startObserving(root);
    }

    /**
     * Transition to loading state: remove ready highlight, register loading highlight.
     * Updates host overlay data-preview-state.
     */
    setLoading(): void {
        this.state = 'loading';
        this.highlights.setState('loading', this.textRanges);
        if (this.host) {
            this.host.setAttribute('data-preview-state', 'loading');
        }
        this.iframePreview.setLoading();
    }

    /**
     * Transition back to ready state: remove loading highlight, register ready highlight.
     * Updates host overlay data-preview-state.
     */
    setReady(): void {
        this.state = 'ready';
        this.highlights.setState('ready', this.textRanges);
        if (this.host) {
            this.host.setAttribute('data-preview-state', 'ready');
        }
        this.iframePreview.setReady();
    }

    /**
     * Set iframe inclusion without re-collecting targets or recreating the host.
     * Idempotent: if the value hasn't changed, nothing happens.
     */
    setIncludeIframes(enabled: boolean): void {
        if (this.includeIframes === enabled) return;
        this.includeIframes = enabled;
        if (enabled && this.rootRef) this.iframePreview.show(this.rootRef);
        if (!enabled) this.iframePreview.remove();
    }

    /**
     * Remove all highlights, host overlay, and clear internal state.
     * Safe to call at any time.
     */
    remove(): void {
        this.highlights.clear();
        this.stopObserving();
        this.removeHost();
        this.iframePreview.remove();
        this.textRanges = [];
        this.boxedElements = [];
        this.rootRef = null;
        this.includeIframes = false;
        this.state = 'ready';
    }

    // ── MutationObserver and rebuild helpers ─────────────────────────────────

    /**
     * Start observing the selected root for DOM mutations.
     * Observes childList, subtree, characterData, and attributes.
     * Does NOT observe the preview host.
     */
    private startObserving(root: HTMLElement): void {
        this.stopObserving();
        this.mutationObserver = new MutationObserver(() => this.scheduleFrame(true));
        this.mutationObserver.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
        });
    }

    /**
     * Disconnect and discard the MutationObserver.
     */
    private stopObserving(): void {
        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }
        this.rebuildPending = false;
    }

    /**
     * Schedule a single requestAnimationFrame for either a full rebuild or a
     * geometry-only box update.  At most one rAF is ever pending.  When
     * `rebuild` is true the rebuild-pending flag is raised so that the
     * pending frame (even if originally queued for geometry) will perform a
     * full rebuild instead.  Rebuild always dominates geometry-only work.
     */
    private scheduleFrame(rebuild: boolean): void {
        if (rebuild) {
            this.rebuildPending = true;
        }
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = 0;
            if (this.rebuildPending) {
                this.rebuildPending = false;
                this.rebuild();
            } else {
                this.updateBoxes();
            }
        });
    }

    /**
     * Full rebuild: recollect targets, replace registry highlights while
     * preserving current ready/loading state, reconnect ResizeObserver, and
     * redraw boxes.
     */
    private rebuild(): void {
        if (!this.rootRef) return;

        const targets = collectContentPreviewTargets(this.rootRef);
        this.textRanges = targets.textRanges;
        this.boxedElements = targets.boxedElements;

        // Re-register current state in the highlight registry
        this.highlights.setState(this.state, this.textRanges);

        // Reconnect ResizeObserver targets
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            if (this.rootRef) {
                this.resizeObserver.observe(this.rootRef);
            }
            for (const el of this.boxedElements) {
                this.resizeObserver.observe(el);
            }
        }

        // Redraw boxes (host may need to be created or removed)
        if (this.boxedElements.length > 0) {
            if (!this.host) {
                this.createHost(this.rootRef);
            }
            this.updateBoxes();
        } else if (this.host) {
            this.removeHost();
        }
        // IframeTextPreview manages itself independently via its own
        // MutationObserver and filtered load handlers, so parent-DOM rebuilds
        // do not destroy all frame contexts and defeat incremental preview.
    }

    // ── Host overlay private helpers ────────────────────────────────────────

    /**
     * Create an isolated Shadow DOM host appended to document.documentElement
     * after <body>.
     */
    private createHost(root: HTMLElement): void {
        this.removeHost();

        this.rootRef = root;

        const host = document.createElement('div');
        host.setAttribute(CONTENT_PREVIEW_HOST_ATTRIBUTE, '');
        host.setAttribute('data-preview-state', this.state);
        host.setAttribute('aria-hidden', 'true');
        host.style.pointerEvents = 'none';

        // Create shadow root for style isolation
        const shadow = host.attachShadow({ mode: 'open' });

        // Inject styles
        const style = document.createElement('style');
        style.textContent = HOST_STYLES;
        shadow.appendChild(style);

        // Lightweight container for child boxes — :host provides fixed viewport
        const container = document.createElement('div');
        container.className = 'content-preview-box-container';
        shadow.appendChild(container);

        document.documentElement.appendChild(host);
        this.host = host;
        this.containerRef = container;

        // Install geometry update listeners
        this.installGeometryListeners();
    }

    /**
     * Install scroll, resize, and ResizeObserver listeners for geometry tracking.
     */
    private installGeometryListeners(): void {
        // Capture-phase passive scroll listener on the document
        this.scrollHandler = () => this.scheduleFrame(false);
        document.addEventListener('scroll', this.scrollHandler, { capture: true, passive: true });

        // Passive window resize listener
        this.resizeHandler = () => this.scheduleFrame(false);
        window.addEventListener('resize', this.resizeHandler, { passive: true });

        // ResizeObserver on root and boxed elements
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.scheduleFrame(false));
            if (this.rootRef) {
                this.resizeObserver.observe(this.rootRef);
            }
            for (const el of this.boxedElements) {
                this.resizeObserver.observe(el);
            }
        }
    }



    /**
     * Recompute client rects for all boxed elements and position
     * `.content-preview-box` elements in the shadow container.
     */
    private updateBoxes(): void {
        if (!this.host) return;
        const container = this.containerRef;
        if (!container) return;

        // Clear existing boxes
        container.innerHTML = '';

        for (const el of this.boxedElements) {
            const rects = el.getClientRects();
            for (let i = 0; i < rects.length; i++) {
                const rect = rects[i];
                if (rect.width <= 0 || rect.height <= 0) continue;

                const box = document.createElement('div');
                box.className = 'content-preview-box';
                // Geometry-only inline styles; visual styles provided by .content-preview-box CSS class
                box.style.top = `${rect.top}px`;
                box.style.left = `${rect.left}px`;
                box.style.width = `${rect.width}px`;
                box.style.height = `${rect.height}px`;
                container.appendChild(box);
            }
        }
        // Loading state styling handled by :host([data-preview-state="loading"]) CSS selector
    }

    /**
     * Remove host element, listeners, observer, and pending frame.
     * Does NOT clear rootRef — that is managed by show()/remove().
     */
    private removeHost(): void {
        // Cancel pending frame
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = 0;
        }

        // Disconnect ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        // Remove scroll listener
        if (this.scrollHandler) {
            document.removeEventListener('scroll', this.scrollHandler, { capture: true } as EventListenerOptions);
            this.scrollHandler = null;
        }

        // Remove resize listener
        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
            this.resizeHandler = null;
        }

        // Remove host element from DOM
        if (this.host && this.host.parentElement) {
            this.host.parentElement.removeChild(this.host);
        }
        this.host = null;
        this.containerRef = null;
    }
}

/** Shadow DOM host styles — injected once per host creation. */
const HOST_STYLES = `
:host {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 2147483647;
}
.content-preview-box {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
  border: 2px solid rgb(16, 185, 129);
  border-radius: 4px;
  background: rgba(16, 185, 129, 0.18);
}
:host([data-preview-state="loading"]) .content-preview-box {
  border-color: rgb(5, 150, 105);
  background: rgba(16, 185, 129, 0.32);
}
`;

const BOXED_SELECTOR = 'img,button,input:not([type="hidden"]),select,textarea';

export interface ContentPreviewTargets {
    textRanges: Range[];
    boxedElements: HTMLElement[];
}

/**
 * Collect all visible text ranges and boxed interactive/media elements
 * within the given root element.
 *
 * - Text ranges come from the shared visible-text walker (skipping excluded and
 *   boxed ancestors, hidden elements, and zero-rect text).
 * - Boxed elements are those matching img, button, input (except hidden), select,
 *   textarea that have visible geometry and are not hidden via style/attribute.
 */
export function collectContentPreviewTargets(root: HTMLElement): ContentPreviewTargets {
    const textRanges = collectVisibleTextRanges(root);
    const boxedElements = collectBoxedElements(root);
    return { textRanges, boxedElements };
}

/**
 * Collect the visible boxed interactive/media elements within the given root.
 */
function collectBoxedElements(root: HTMLElement): HTMLElement[] {
    const boxedElements: HTMLElement[] = [];
    const ownerDocument = root.ownerDocument;
    const view = ownerDocument.defaultView ?? window;

    // ── Collect boxed elements ────────────────────────────────────────────────
    // Include root itself if it matches
    const candidates: Element[] = [];
    if (root.matches(BOXED_SELECTOR)) {
        candidates.push(root);
    }
    candidates.push(...root.querySelectorAll(BOXED_SELECTOR));

    for (const el of candidates) {
        const htmlEl = el as HTMLElement;

        // Reject if element is inside another boxed ancestor (e.g., input inside button)
        const closestBoxed = htmlEl.closest(BOXED_ANCESTORS);
        if (closestBoxed && closestBoxed !== htmlEl) {
            continue;
        }

        const style = view.getComputedStyle(htmlEl);

        // Reject if display is none
        if (style.display === 'none') {
            continue;
        }
        // Reject if visibility is hidden or collapse
        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
            continue;
        }
        // Reject if opacity is 0
        const opacity = parseFloat(style.opacity);
        if (opacity === 0) {
            continue;
        }
        // Reject if element has hidden attribute
        if (htmlEl.hasAttribute('hidden')) {
            continue;
        }
        // Require at least one non-empty client rect
        const rects = el.getClientRects();
        if (hasNonEmptyRect(rects)) {
            boxedElements.push(htmlEl);
        }
    }

    return boxedElements;
}
