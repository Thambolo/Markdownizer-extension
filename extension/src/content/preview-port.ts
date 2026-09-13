import { hasEligibleIframesLightweight, hasImagesInRoot } from '../extraction/iframe-capture';
import { CONTENT_PREVIEW_HOST_ATTRIBUTE } from '../preview/content-preview';
import type { ContentPreview } from '../preview/content-preview';
import type { CaptureMode, PreviewCommand, PreviewEligibilityMessage } from '../shared/preview-protocol';
import type { EligibilityWatcher } from './eligibility-watcher';
import { getCaptureStrategy } from './strategies';

export function normalizeCaptureMode(value: unknown): CaptureMode {
    return value === 'full-page' ? 'full-page' : 'smart';
}

export function normalizeIncludeIframes(value: unknown): boolean {
    return value === true;
}

/**
 * Only one connection owns the preview overlay at a time: the most recent
 * preview:show wins, and stale ports can never change or remove it.
 */
interface OwnerState {
    port: chrome.runtime.Port;
    sessionId: string;
    generation: number;
}

let currentOwner: OwnerState | null = null;

/** Check whether a mutation record is caused by the preview host overlay. */
export function isPreviewHostMutation(record: MutationRecord): boolean {
    const target = record.target;
    if (target instanceof Element) {
        if (target.hasAttribute(CONTENT_PREVIEW_HOST_ATTRIBUTE)) return true;
        if (target.closest?.(`[${CONTENT_PREVIEW_HOST_ATTRIBUTE}]`)) return true;
    }
    return false;
}

/**
 * Tag-name check (not instanceof): a loaded same-origin frame's document
 * is a separate DOM tree whose nodes belong to the frame's realm, so
 * `instanceof HTMLImageElement` never matches them. Tag names work across
 * realms, keeping frame-document mutations recognizable.
 */
function hasIframeOrImageTag(node: unknown): boolean {
    if (typeof node !== 'object' || node === null) return false;
    const tag = (node as { tagName?: unknown }).tagName;
    return tag === 'IFRAME' || tag === 'IMG';
}

/**
 * Owns one preview-port connection: routes the preview command protocol to
 * the shared ContentPreview, tracks the inspection state (generation, capture
 * root) that eligibility depends on, and drives the per-connection watcher.
 */
export class PreviewPortController {
    private readonly port: chrome.runtime.Port;
    private readonly generation: number;
    private readonly watcher: EligibilityWatcher;
    private readonly preview: ContentPreview;
    private latestInspection: { captureMode: CaptureMode; generation: number; includeIframes: boolean } | null = null;
    private acceptedInspectionGeneration = -1;
    private currentSessionId = '';

    // Cached live root from selectCaptureRoot — never re-derived via getContentForMode
    private cachedRoot: HTMLElement | null = null;

    constructor(port: chrome.runtime.Port, generation: number, watcher: EligibilityWatcher, preview: ContentPreview) {
        this.port = port;
        this.generation = generation;
        this.watcher = watcher;
        this.preview = preview;
        port.onMessage.addListener(this.handleMessage);
        port.onDisconnect.addListener(this.handleDisconnect);
    }

    /** The live capture root cached by the last preview:inspect (or null). */
    getRoot(): HTMLElement | null {
        return this.cachedRoot;
    }

    postEligibility(): void {
        if (!this.latestInspection) return;
        // Reject stale generation inspections
        if (this.latestInspection.generation < this.acceptedInspectionGeneration) return;
        // Use lightweight eligibility — never call getContentForMode
        const root = this.cachedRoot ?? getCaptureStrategy(this.latestInspection.captureMode).selectRoot();
        if (!root) return;
        const response: PreviewEligibilityMessage = {
            type: 'preview:eligibility',
            sessionId: this.currentSessionId,
            captureMode: this.latestInspection.captureMode,
            generation: this.latestInspection.generation,
            hasEligibleIframes: hasEligibleIframesLightweight(root),
            hasImages: hasImagesInRoot(root, this.latestInspection.includeIframes),
        };
        this.port.postMessage(response);
    }

    /** Check whether a mutation record involves iframes or images. */
    isCaptureRelevantMutation(record: MutationRecord): boolean {
        if (isPreviewHostMutation(record)) return false;

        // Target is an iframe or image element itself (e.g. src attribute change)
        if (hasIframeOrImageTag(record.target)) return true;

        // Added nodes include an iframe or image
        if (record.type === 'childList' && record.addedNodes?.length) {
            const addedRelevant = Array.from(record.addedNodes).some((node) => {
                const element = node as Element;
                if (typeof element.matches !== 'function') return false;
                return element.matches('iframe,img') || !!element.querySelector?.('iframe,img');
            });
            if (addedRelevant) return true;
        }

        // Attribute change on an iframe within the cached root
        if (record.type === 'attributes' && hasIframeOrImageTag(record.target)) {
            if (this.cachedRoot?.contains(record.target)) return true;
        }

        return false;
    }

    handleMessage = (msg: unknown): void => {
        const cmd = msg as PreviewCommand;

        switch (cmd.type) {
            case 'preview:show': {
                const captureMode = normalizeCaptureMode(cmd.captureMode);
                const root = getCaptureStrategy(captureMode).selectRoot();
                if (!root) {
                    this.port.postMessage({
                        success: false,
                        error: 'No visible source element found.',
                    });
                    return;
                }
                currentOwner = { port: this.port, sessionId: cmd.sessionId, generation: this.generation };
                this.preview.show(root);
                this.port.postMessage({ success: true });
                break;
            }
            case 'preview:inspect': {
                const captureMode = normalizeCaptureMode(cmd.captureMode);
                // Reject stale generation: only accept inspections at or above the current accepted generation
                if (cmd.generation < this.acceptedInspectionGeneration) return;
                this.acceptedInspectionGeneration = cmd.generation;
                this.currentSessionId = cmd.sessionId;
                this.latestInspection = {
                    captureMode,
                    generation: cmd.generation,
                    // Default false when undefined: with iframes excluded, frame
                    // images never reach the Markdown so they must not count.
                    includeIframes: normalizeIncludeIframes(cmd.includeIframes),
                };
                // Cache the live root from selectCaptureRoot — never derive via getContentForMode
                const newRoot = getCaptureStrategy(captureMode).selectRoot();
                if (newRoot !== this.cachedRoot) {
                    // Root changed — tear down old watcher, set up new one
                    this.watcher.stop();
                    this.cachedRoot = newRoot;
                }
                this.watcher.start();
                this.postEligibility();
                break;
            }
            case 'preview:set-iframes': {
                // Only the current generation may change state
                if (!currentOwner || currentOwner.generation !== this.generation) return;
                this.preview.setIncludeIframes(cmd.enabled === true);
                break;
            }

            default: {
                // Only the current generation may change state or remove
                if (!currentOwner || currentOwner.generation !== this.generation) return;

                if (cmd.type === 'preview:loading') {
                    this.preview.setLoading();
                } else if (cmd.type === 'preview:ready') {
                    this.preview.setReady();
                } else if (cmd.type === 'preview:hide') {
                    this.preview.remove();
                    currentOwner = null;
                }
                break;
            }
        }
    };

    handleDisconnect = (): void => {
        this.port.onMessage.removeListener(this.handleMessage);
        this.watcher.stop();
        this.cachedRoot = null;
        // Only the current generation cleans up
        if (currentOwner && currentOwner.generation === this.generation) {
            this.preview.remove();
            currentOwner = null;
        }
    };
}