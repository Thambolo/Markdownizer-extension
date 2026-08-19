import { IFRAME_MAX_COUNT, readSameOriginFrame } from '../extraction/iframe-capture';

export interface EligibilityWatcherOptions {
    getRoot: () => HTMLElement | null;
    postEligibility: () => void;
    isCaptureRelevantMutation: (record: MutationRecord) => boolean;
    isPreviewHostMutation: (record: MutationRecord) => boolean;
}

/**
 * Observes the live capture root (and the documents of readable same-origin
 * frames inside it) for mutations that can change preview eligibility —
 * iframes/images appearing or gaining a src — and triggers an eligibility
 * refresh. All pages state comes from the options bag, so the extension can
 * swap the source of truth without touching this class.
 */
export class EligibilityWatcher {
    private eligibilityObserver: MutationObserver | null = null;
    private readonly frameObserverMap = new Map<HTMLIFrameElement, { observer: MutationObserver; document: Document }>();
    private refreshFrame = 0;
    private watcherActive = true;

    constructor(private readonly opts: EligibilityWatcherOptions) {}

    /** Cached live root from selectCaptureRoot — never re-derived via getContentForMode. */
    private resolveObserveTarget(): HTMLElement {
        return this.opts.getRoot() ?? document.body;
    }

    /** Observer attach + load listener + frame reconcile. */
    start(): void {
        this.watcherActive = true;
        if (this.eligibilityObserver) return;
        // Observe the cached root (or document.body fallback), NOT document.documentElement
        const observeTarget = this.resolveObserveTarget();
        this.eligibilityObserver = new MutationObserver((records) => this.handleMutations(records));
        this.eligibilityObserver.observe(observeTarget, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcdoc', 'sandbox', 'title'],
        });
        document.addEventListener('load', this.handleFrameLoad, true);
        this.reconcileFrameDocumentObservers();
    }

    /** Full teardown (idempotent). */
    stop(): void {
        this.watcherActive = false;
        this.eligibilityObserver?.disconnect();
        this.eligibilityObserver = null;
        for (const { observer } of this.frameObserverMap.values()) observer.disconnect();
        this.frameObserverMap.clear();
        document.removeEventListener('load', this.handleFrameLoad, true);
        if (this.refreshFrame) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.refreshFrame);
            else window.clearTimeout(this.refreshFrame);
            this.refreshFrame = 0;
        }
    }

    /**
     * A frame's document is a separate DOM tree: mutations inside an already
     * loaded same-origin frame would never reach the root observer, leaving
     * the toggle stale (e.g. lazy-loaded images inside the frame). Keep one
     * observer per readable top-level frame, bounded by IFRAME_MAX_COUNT,
     * and diff the attachments against the current root so that iframes
     * added after inspection get observed and navigated frames get re-observed
     * (old document disconnected, new document attached).
     * Frames inside frames are intentionally NOT observed here — the watcher
     * restarts on every inspection, so nested content is picked up when a
     * parent frame becomes eligible or the user re-inspects.
     */
    reconcileFrameDocumentObservers(): void {
        const observeTarget = this.resolveObserveTarget();
        const frames = Array.from(observeTarget.querySelectorAll<HTMLIFrameElement>('iframe'));

        // Detach entries whose frame left the root or whose document changed
        // (navigation replaces the frame's document).
        for (const [frame, entry] of this.frameObserverMap) {
            if (!frames.includes(frame) || entry.document !== readSameOriginFrame(frame)) {
                entry.observer.disconnect();
                this.frameObserverMap.delete(frame);
            }
        }

        // Attach observers for readable frames not yet tracked.
        for (const frame of frames) {
            if (this.frameObserverMap.size >= IFRAME_MAX_COUNT) break;
            if (this.frameObserverMap.has(frame)) continue;
            const frameDocument = readSameOriginFrame(frame);
            if (!frameDocument) continue;
            const observer = new MutationObserver((records) => this.handleMutations(records));
            observer.observe(frameDocument, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'srcdoc', 'sandbox', 'title'],
            });
            this.frameObserverMap.set(frame, { observer, document: frameDocument });
        }
    }

    private scheduleEligibilityRefresh(): void {
        if (this.refreshFrame) return;
        const refresh = () => {
            this.refreshFrame = 0;
            // Reconcile frame-document observers before re-reading: iframes
            // added to the root since the last refresh (or navigated frames
            // with a replaced document) get a live observer now, so their
            // later mutations keep the toggle fresh. Diff-based and
            // rAF-coalesced, so a no-op when nothing changed.
            this.reconcileFrameDocumentObservers();
            this.opts.postEligibility();
        };
        if (typeof requestAnimationFrame === 'function') {
            this.refreshFrame = requestAnimationFrame(refresh);
        } else {
            this.refreshFrame = window.setTimeout(refresh, 0);
        }
    }

    private readonly handleFrameLoad = (event: Event): void => {
        if (!this.watcherActive) return;
        const target = event.target;
        // Only refresh when the loaded iframe is within the cached root
        if (target instanceof HTMLIFrameElement && this.opts.getRoot()?.contains(target)) {
            this.scheduleEligibilityRefresh();
        }
    };

    private handleMutations(records: MutationRecord[]): void {
        if (!this.watcherActive) return;
        if (records.some((record) => this.opts.isCaptureRelevantMutation(record))) {
            this.scheduleEligibilityRefresh();
        }
    }
}