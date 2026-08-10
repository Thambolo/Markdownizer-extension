import {
    IFRAME_MAX_DEPTH,
    createIframeBudget,
    readSameOriginFrame,
} from './iframe-capture';
import { LOADING_HIGHLIGHT_NAME, READY_HIGHLIGHT_NAME } from './preview-highlights';

const PREVIEW_STYLE_ATTRIBUTE = 'data-markdownizer-iframe-preview-style';
const EXCLUDED_ANCESTORS = 'script,style,noscript,template';
const BOXED_ANCESTORS = 'button,input,select,textarea';
const SHOW_TEXT = 4;

interface HighlightRegistry {
    set(name: string, value: unknown): void;
    delete(name: string): void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

export interface FrameContext {
    iframe: HTMLIFrameElement;
    document: Document;
    root: HTMLElement;
    registry: HighlightRegistry | null;
    Highlight: HighlightConstructor | null;
    style: HTMLStyleElement | null;
    observer: MutationObserver | null;
    loadHandler: (event: Event) => void;
    ranges: Range[];
    /** Reference to the filtered ownerDocument load handler for cleanup */
    _filteredLoadHandler?: (event: Event) => void;
}

function getFrameHighlightAPI(doc: Document): {
    registry: HighlightRegistry | null;
    Highlight: HighlightConstructor | null;
} {
    const view = doc.defaultView as (Window & {
        CSS?: { highlights?: HighlightRegistry };
        Highlight?: HighlightConstructor;
    }) | null;
    return {
        registry: view?.CSS?.highlights ?? null,
        Highlight: view?.Highlight ?? null,
    };
}

function isHidden(element: Element, boundary: Element, view: Window): boolean {
    for (let current: Element | null = element; current && current !== boundary; current = current.parentElement) {
        if (current.hasAttribute('hidden')) return true;
        const style = view.getComputedStyle(current);
        if (style.display === 'none') return true;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
        if (parseFloat(style.opacity) === 0) return true;
    }
    return false;
}

function collectVisibleTextRanges(root: HTMLElement): Range[] {
    const ownerDocument = root.ownerDocument;
    const view = ownerDocument.defaultView;
    if (!view) return [];

    const ranges: Range[] = [];
    const walker = ownerDocument.createTreeWalker(root, SHOW_TEXT, {
        acceptNode(node) {
            const text = node.textContent;
            const parent = node.parentElement;
            if (!text?.trim() || !parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest(EXCLUDED_ANCESTORS) || parent.closest(BOXED_ANCESTORS)) return NodeFilter.FILTER_REJECT;
            if (isHidden(parent, root, view)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    let node: Node | null;
    while ((node = walker.nextNode())) {
        const range = ownerDocument.createRange();
        range.selectNodeContents(node);
        try {
            if (Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) {
                ranges.push(range);
            }
        } catch {
            // A frame can navigate while ranges are being collected.
        }
    }
    return ranges;
}

export class IframeTextPreview {
    private rootRef: HTMLElement | null = null;
    private contexts = new Map<HTMLIFrameElement, FrameContext>();
    private state: 'ready' | 'loading' = 'ready';
    private budget = createIframeBudget();
    private rebuildFrame = 0;
    /** Queued targeted range rebuilds for specific frames, flushed in the next rAF */
    private pendingRangeRebuilds = new Set<FrameContext>();
    /** Queued branch reconciliations for specific iframes, flushed in the next rAF */
    private pendingBranchReconciles = new Set<HTMLIFrameElement>();
    /** Observer on the root that detects iframe additions/removals */
    private rootObserver: MutationObserver | null = null;

    show(root: HTMLElement): void {
        this.remove();
        this.rootRef = root;
        this.state = 'ready';
        this.rebuildContexts();
    }

    setLoading(): void {
        this.state = 'loading';
        this.updateAllHighlights();
    }

    setReady(): void {
        this.state = 'ready';
        this.updateAllHighlights();
    }

    /**
     * Reconcile branch: rebuild only the context for the given iframe and its descendants.
     * Used on iframe navigation or add/remove.
     */
    reconcileBranch(iframe: HTMLIFrameElement): void {
        const existing = this.contexts.get(iframe);
        if (existing) {
            this.destroyContext(existing);
            this.contexts.delete(iframe);
        }

        // Try to create a new context for this iframe
        const frameDocument = readSameOriginFrame(iframe);
        if (!frameDocument?.body) return;

        const frameRoot = frameDocument.body;
        const newContext = this.createContext(frameDocument, frameRoot, iframe);
        this.contexts.set(iframe, newContext);

        // Update highlights for this specific context
        this.updateContextHighlight(newContext);
    }

    /**
     * Remove branch: destroy the context for the given iframe and its descendants.
     */
    removeBranch(iframe: HTMLIFrameElement): void {
        const context = this.contexts.get(iframe);
        if (!context) return;
        this.destroyContext(context);
        this.contexts.delete(iframe);
    }

    /**
     * Rebuild ranges for a single context. Used on mutations within one frame document.
     */
    rebuildRanges(context: FrameContext): void {
        context.ranges = collectVisibleTextRanges(context.root);
        this.updateContextHighlight(context);
    }

    remove(): void {
        this.clearAllContexts();
        this.rootRef = null;
        this.budget = createIframeBudget();
        this.state = 'ready';
    }

    private rebuildContexts(): void {
        if (!this.rootRef) return;
        this.budget = createIframeBudget();
        this.traverse(this.rootRef, 1);
        this.updateAllHighlights();
        this.startRootObserver();
    }

    private traverse(root: HTMLElement, depth: number): void {
        if (depth > IFRAME_MAX_DEPTH || this.budget.count >= this.budget.maxCount) return;
        for (const iframe of Array.from(root.querySelectorAll<HTMLIFrameElement>('iframe'))) {
            if (this.budget.count >= this.budget.maxCount) break;
            const frameDocument = readSameOriginFrame(iframe);
            if (!frameDocument?.body) continue;

            this.budget.count += 1;
            const frameRoot = frameDocument.body;
            const context = this.createContext(frameDocument, frameRoot, iframe);
            this.contexts.set(iframe, context);
            this.traverse(frameRoot, depth + 1);
        }
    }

    private createContext(doc: Document, root: HTMLElement, iframe: HTMLIFrameElement): FrameContext {
        const api = getFrameHighlightAPI(doc);
        const context: FrameContext = {
            iframe,
            document: doc,
            root,
            registry: api.registry,
            Highlight: api.Highlight,
            style: null,
            observer: null,
            loadHandler: () => undefined,
            ranges: [],
        };

        const style = doc.createElement('style');
        style.setAttribute(PREVIEW_STYLE_ATTRIBUTE, '');
        style.textContent = `
            ::highlight(${READY_HIGHLIGHT_NAME}) {
                background-color: rgba(16, 185, 129, 0.24);
                text-decoration-line: underline;
                text-decoration-color: rgba(5, 150, 105, 0.9);
                text-decoration-thickness: 2px;
                text-underline-offset: 2px;
            }
            ::highlight(${LOADING_HIGHLIGHT_NAME}) {
                background-color: rgba(16, 185, 129, 0.38);
                text-decoration-line: underline;
                text-decoration-color: rgb(5, 150, 105);
                text-decoration-thickness: 2px;
                text-underline-offset: 2px;
            }
        `;
        (doc.head ?? doc.documentElement).appendChild(style);
        context.style = style;
        context.ranges = collectVisibleTextRanges(root);

        // MutationObserver: queue targeted range rebuild for this context only
        context.observer = new MutationObserver(() => this.scheduleRangeRebuild(context));
        context.observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });

        // Filtered iframe load handler: only reconcile this branch, not a full rebuild.
        // Navigation destroys the old document and replaces it with a new one, so
        // we must do reconcileBranch rather than just rebuildRanges.
        const iframeLoadHandler = () => this.scheduleBranchReconcile(iframe);
        iframe.addEventListener('load', iframeLoadHandler, true);
        context.loadHandler = iframeLoadHandler;

        // Filtered ownerDocument load handler: only respond to events from this specific iframe
        const filteredLoadHandler = (event: Event) => {
            if (event.target === iframe) {
                this.scheduleBranchReconcile(iframe);
            }
        };
        iframe.ownerDocument.addEventListener('load', filteredLoadHandler, true);
        context._filteredLoadHandler = filteredLoadHandler;

        return context;
    }

    private updateAllHighlights(): void {
        for (const context of this.contexts.values()) {
            this.updateContextHighlight(context);
        }
    }

    private updateContextHighlight(context: FrameContext): void {
        context.registry?.delete(READY_HIGHLIGHT_NAME);
        context.registry?.delete(LOADING_HIGHLIGHT_NAME);
        if (!context.registry || !context.Highlight) return;
        const highlight = new context.Highlight(...context.ranges);
        context.registry.set(
            this.state === 'loading' ? LOADING_HIGHLIGHT_NAME : READY_HIGHLIGHT_NAME,
            highlight,
        );
    }

    /**
     * Queue a targeted range rebuild for a single context. Coalesced in a single rAF.
     */
    private scheduleRangeRebuild(context: FrameContext): void {
        this.pendingRangeRebuilds.add(context);
        this.scheduleFrame();
    }

    /**
     * Queue a branch reconcile for a single iframe. Coalesced in a single rAF.
     * Used on iframe load/navigation events.
     */
    private scheduleBranchReconcile(iframe: HTMLIFrameElement): void {
        this.pendingBranchReconciles.add(iframe);
        this.scheduleFrame();
    }

    private scheduleFrame(): void {
        if (this.rebuildFrame) return;
        const rebuild = () => {
            this.rebuildFrame = 0;
            this.flushPendingRangeRebuilds();
        };
        const view = this.rootRef?.ownerDocument.defaultView;
        if (view?.requestAnimationFrame) this.rebuildFrame = view.requestAnimationFrame(rebuild);
        else this.rebuildFrame = window.setTimeout(rebuild, 0);
    }

    private flushPendingRangeRebuilds(): void {
        // First, flush any branch reconciles (they may create new contexts)
        const iframes = Array.from(this.pendingBranchReconciles);
        this.pendingBranchReconciles.clear();
        for (const iframe of iframes) {
            if (!this.rootRef) break;
            this.reconcileBranch(iframe);
        }

        // Then, flush targeted range rebuilds for remaining contexts
        const contexts = Array.from(this.pendingRangeRebuilds);
        this.pendingRangeRebuilds.clear();
        for (const context of contexts) {
            // Verify the context is still tracked (not removed during navigation)
            if (!this.contexts.has(context.iframe)) continue;
            this.rebuildRanges(context);
        }
    }

    private destroyContext(context: FrameContext): void {
        context.registry?.delete(READY_HIGHLIGHT_NAME);
        context.registry?.delete(LOADING_HIGHLIGHT_NAME);
        context.observer?.disconnect();
        context.iframe.removeEventListener('load', context.loadHandler, true);
        if (context._filteredLoadHandler) {
            context.iframe.ownerDocument.removeEventListener('load', context._filteredLoadHandler, true);
        }
        context.style?.remove();
    }

    private clearAllContexts(): void {
        if (this.rebuildFrame) {
            const view = this.rootRef?.ownerDocument.defaultView;
            if (view?.cancelAnimationFrame) view.cancelAnimationFrame(this.rebuildFrame);
            else window.clearTimeout(this.rebuildFrame);
            this.rebuildFrame = 0;
        }
        this.pendingRangeRebuilds.clear();
        this.pendingBranchReconciles.clear();
        for (const context of this.contexts.values()) {
            this.destroyContext(context);
        }
        this.contexts.clear();
        this.stopRootObserver();
    }

    /**
     * Observe the root for iframe additions and removals.
     * When a new iframe is appended, reconcile its branch.
     * When an iframe is removed, clean up its branch.
     */
    private startRootObserver(): void {
        this.stopRootObserver();
        if (!this.rootRef) return;

        this.rootObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                // Process added nodes
                for (const node of Array.from(mutation.addedNodes)) {
                    if (node instanceof HTMLIFrameElement) {
                        this.scheduleBranchReconcile(node);
                    } else if (node instanceof HTMLElement) {
                        for (const iframe of Array.from(node.querySelectorAll<HTMLIFrameElement>('iframe'))) {
                            this.scheduleBranchReconcile(iframe);
                        }
                    }
                }
                // Process removed nodes
                for (const node of Array.from(mutation.removedNodes)) {
                    if (node instanceof HTMLIFrameElement) {
                        this.removeBranch(node);
                    } else if (node instanceof HTMLElement) {
                        for (const iframe of Array.from(node.querySelectorAll<HTMLIFrameElement>('iframe'))) {
                            this.removeBranch(iframe);
                        }
                    }
                }
            }
        });
        this.rootObserver.observe(this.rootRef, { childList: true, subtree: true });
    }

    private stopRootObserver(): void {
        if (this.rootObserver) {
            this.rootObserver.disconnect();
            this.rootObserver = null;
        }
    }
}
