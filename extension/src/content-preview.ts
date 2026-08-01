export const CONTENT_PREVIEW_HOST_ATTRIBUTE = 'data-markdownizer-content-preview-host';

export const READY_HIGHLIGHT_NAME = 'markdownizer-preview-ready';
export const LOADING_HIGHLIGHT_NAME = 'markdownizer-preview-loading';

/**
 * Minimal structural interface for the CSS Custom Highlight registry.
 * Avoids dependency on a DOM lib type that may not exist yet.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface HighlightRegistry {
    set(name: string, highlight: any): void;
    delete(name: string): void;
    has(name: string): boolean;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Return the CSS highlight registry if the API is available, null otherwise.
 * Guards against environments where CSS.highlights or Highlight is missing.
 */
function getHighlightRegistry(): HighlightRegistry | null {
    if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') {
        return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (CSS as any).highlights as HighlightRegistry;
}

/**
 * ContentPreview manages the lifecycle of CSS Custom Highlight overlays
 * for the markdownizer content preview, plus an optional host overlay that
 * renders `.content-preview-box` rectangles over visible boxed elements.
 */
export class ContentPreview {
    private textRanges: Range[] = [];
    private boxedElements: HTMLElement[] = [];
    private state: 'ready' | 'loading' = 'ready';

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

    /**
     * Show the content preview for the given root element.
     * Calls remove() first to clear any stale state, then collects targets
     * and registers a ready highlight. When boxed elements exist, creates
     * an isolated host overlay with `.content-preview-box` rectangles.
     */
    show(root: HTMLElement): void {
        this.remove();
        this.rootRef = root;
        const targets = collectContentPreviewTargets(root);
        this.textRanges = targets.textRanges;
        this.boxedElements = targets.boxedElements;
        this.state = 'ready';

        const registry = getHighlightRegistry();
        if (registry) {
            const highlight = new Highlight(...this.textRanges);
            registry.set(READY_HIGHLIGHT_NAME, highlight);
        }

        // Create host overlay only when boxed elements exist
        if (this.boxedElements.length > 0) {
            this.createHost(root);
            this.updateBoxes();
        }

        // Observe the selected root for mutations (not the host)
        this.startObserving(root);
    }

    /**
     * Transition to loading state: remove ready highlight, register loading highlight.
     * Updates host overlay data-preview-state.
     */
    setLoading(): void {
        this.state = 'loading';
        const registry = getHighlightRegistry();
        if (registry) {
            registry.delete(READY_HIGHLIGHT_NAME);
            registry.delete(LOADING_HIGHLIGHT_NAME);
            const highlight = new Highlight(...this.textRanges);
            registry.set(LOADING_HIGHLIGHT_NAME, highlight);
        }
        if (this.host) {
            this.host.setAttribute('data-preview-state', 'loading');
        }
    }

    /**
     * Transition back to ready state: remove loading highlight, register ready highlight.
     * Updates host overlay data-preview-state.
     */
    setReady(): void {
        this.state = 'ready';
        const registry = getHighlightRegistry();
        if (registry) {
            registry.delete(READY_HIGHLIGHT_NAME);
            registry.delete(LOADING_HIGHLIGHT_NAME);
            const highlight = new Highlight(...this.textRanges);
            registry.set(READY_HIGHLIGHT_NAME, highlight);
        }
        if (this.host) {
            this.host.setAttribute('data-preview-state', 'ready');
        }
    }

    /**
     * Remove all highlights, host overlay, and clear internal state.
     * Safe to call at any time.
     */
    remove(): void {
        const registry = getHighlightRegistry();
        if (registry) {
            registry.delete(READY_HIGHLIGHT_NAME);
            registry.delete(LOADING_HIGHLIGHT_NAME);
        }
        this.stopObserving();
        this.removeHost();
        this.textRanges = [];
        this.boxedElements = [];
        this.rootRef = null;
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
        const registry = getHighlightRegistry();
        if (registry) {
            registry.delete(READY_HIGHLIGHT_NAME);
            registry.delete(LOADING_HIGHLIGHT_NAME);
            const highlight = new Highlight(...this.textRanges);
            if (this.state === 'loading') {
                registry.set(LOADING_HIGHLIGHT_NAME, highlight);
            } else {
                registry.set(READY_HIGHLIGHT_NAME, highlight);
            }
        }

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

const EXCLUDED_TEXT_ANCESTORS = 'script,style,noscript,template';
const BOXED_SELECTOR = 'img,button,input:not([type="hidden"]),select,textarea';
const BOXED_ANCESTORS = 'button,input,select,textarea';

export interface ContentPreviewTargets {
    textRanges: Range[];
    boxedElements: HTMLElement[];
}

/**
 * Check if an element is effectively hidden, either by its own styles/attributes
 * or by any ancestor up to (but not including) the root boundary.
 * Returns true if the element or any ancestor has:
 * - `hidden` attribute
 * - `display: none`
 * - `visibility: hidden` or `visibility: collapse`
 * - `opacity: 0`
 */
function isElementHidden(el: Element, boundary: Element): boolean {
    let current: Element | null = el;
    while (current && current !== boundary) {
        if (current.hasAttribute('hidden')) return true;
        const style = window.getComputedStyle(current);
        if (style.display === 'none') return true;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
        if (parseFloat(style.opacity) === 0) return true;
        current = current.parentElement;
    }
    return false;
}

/**
 * Check if a DOMRectList or DOMRect[] contains at least one non-empty rect
 * (width > 0 and height > 0).
 */
function hasNonEmptyRect(rects: DOMRectList | DOMRect[]): boolean {
    for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (rect.width > 0 && rect.height > 0) {
            return true;
        }
    }
    return false;
}

/**
 * Collect all visible text ranges and boxed interactive/media elements
 * within the given root element.
 *
 * - Text nodes in excluded ancestors (script, style, noscript, template) are skipped.
 * - Text nodes inside boxed ancestors (button, input, select, textarea) are skipped
 *   to avoid duplication.
 * - Boxed elements are those matching img, button, input (except hidden), select,
 *   textarea that have visible geometry and are not hidden via style/attribute.
 */
export function collectContentPreviewTargets(root: HTMLElement): ContentPreviewTargets {
    const textRanges: Range[] = [];
    const boxedElements: HTMLElement[] = [];

    // ── Collect visible text ranges ───────────────────────────────────────────
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            // Skip empty/whitespace-only text
            const text = node.textContent;
            if (!text || text.trim().length === 0) {
                return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (!parent) {
                return NodeFilter.FILTER_REJECT;
            }
            // Skip text inside excluded ancestors
            if (parent.closest(EXCLUDED_TEXT_ANCESTORS)) {
                return NodeFilter.FILTER_REJECT;
            }
            // Skip text inside boxed ancestors (button, input, select, textarea)
            if (parent.closest(BOXED_ANCESTORS)) {
                return NodeFilter.FILTER_REJECT;
            }
            // Skip text in hidden elements (hidden attr, display:none, visibility:hidden/collapse, opacity:0)
            if (isElementHidden(parent, root)) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rects = range.getClientRects();
        if (hasNonEmptyRect(rects)) {
            textRanges.push(range);
        }
    }

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

        const style = window.getComputedStyle(htmlEl);

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

    return { textRanges, boxedElements };
}
