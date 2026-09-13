/**
 * CSS Custom Highlight helpers shared between the top-document content
 * preview and the per-frame iframe preview.
 */

/** Minimal structural interface for the CSS Custom Highlight registry. */
export interface HighlightRegistry {
    set(name: string, value: unknown): void;
    delete(name: string): void;
    has(name: string): boolean;
}

export type HighlightConstructor = new (...ranges: Range[]) => unknown;

export type HighlightStateName = 'ready' | 'loading';

/**
 * Return the CSS highlight registry if the API is available, null otherwise.
 * Guards against environments where CSS.highlights or Highlight is missing.
 */
export function getHighlightRegistry(): HighlightRegistry | null {
    if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') {
        return null;
    }
    return (CSS as { highlights?: HighlightRegistry }).highlights as HighlightRegistry;
}

/**
 * Return the global Highlight constructor if available, null otherwise.
 */
export function getHighlightConstructor(): HighlightConstructor | null {
    if (typeof Highlight === 'undefined') return null;
    return Highlight;
}

/**
 * Manages the ready/loading highlight swap against a CSS highlight registry.
 * Encapsulates the delete-both-then-set dance used by both the top-document
 * content preview and the per-frame iframe preview.
 */
export class HighlightService {
    private registry: HighlightRegistry | null;
    private HighlightCtor: HighlightConstructor | null;
    private readyName: string;
    private loadingName: string;

    constructor(
        registry: HighlightRegistry | null,
        HighlightCtor: HighlightConstructor | null,
        readyName: string,
        loadingName: string,
    ) {
        this.registry = registry;
        this.HighlightCtor = HighlightCtor;
        this.readyName = readyName;
        this.loadingName = loadingName;
    }

    /**
     * Replace the current highlight with `name` over `ranges`.
     *
     * Both registry names are deleted first — whenever the registry exists,
     * even when the constructor is null — then the chosen name is set only when
     * both the registry and the constructor are available.
     */
    setState(name: HighlightStateName, ranges: Range[]): void {
        if (this.registry) {
            this.registry.delete(this.readyName);
            this.registry.delete(this.loadingName);
        }
        if (!this.registry || !this.HighlightCtor) return;
        const highlight = new this.HighlightCtor(...ranges);
        this.registry.set(name === 'ready' ? this.readyName : this.loadingName, highlight);
    }

    /** Delete both registry names (no-op when there is no registry). */
    clear(): void {
        if (this.registry) {
            this.registry.delete(this.readyName);
            this.registry.delete(this.loadingName);
        }
    }
}
