export const PREVIEW_HOST_ATTRIBUTE = 'data-markdownizer-preview-host';

const STYLES = `
:host {
    display: block;
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 2147483647;
}
.layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    box-sizing: border-box;
    outline: 2px solid #6366f1;
    background: rgba(99, 102, 241, 0.08);
}
.badge {
    position: absolute;
    top: 6px;
    left: 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 24px;
    padding: 4px 8px;
    background: #0f172a;
    border: 1px solid #6366f1;
    border-radius: 6px;
    pointer-events: none;
    white-space: nowrap;
    visibility: visible;
}
.badge img {
    width: 14px;
    height: 14px;
    display: block;
}
.badge span {
    font-size: 11px;
    font-weight: 600;
    color: #c7d2fe;
}
:host([data-preview-state="loading"]) .layer {
    animation: mdz-shimmer 1.5s ease-in-out infinite;
}
@keyframes mdz-shimmer {
    0% { background: rgba(99, 102, 241, 0.08); }
    50% { background: rgba(99, 102, 241, 0.18); }
    100% { background: rgba(99, 102, 241, 0.08); }
}
@media (prefers-reduced-motion: reduce) {
    :host([data-preview-state="loading"]) .layer {
        animation: none;
        background: rgba(99, 102, 241, 0.18);
    }
}
`;

export class CapturePreview {
    private host: HTMLElement | null = null;
    private layer: HTMLDivElement | null = null;
    private badge: HTMLDivElement | null = null;
    private root: HTMLElement | null = null;

    private rafId: number | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private mutationObserver: MutationObserver | null = null;
    private scrollHandler: (() => void) | null = null;
    private resizeHandler: (() => void) | null = null;

    show(root: HTMLElement): void {
        this.remove();

        this.root = root;

        const host = document.createElement('div');
        host.setAttribute(PREVIEW_HOST_ATTRIBUTE, '');
        host.setAttribute('aria-hidden', 'true');
        host.dataset.previewState = 'ready';

        const shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = STYLES;
        shadow.appendChild(style);

        const layer = document.createElement('div');
        layer.className = 'layer';
        shadow.appendChild(layer);

        const badge = document.createElement('div');
        badge.className = 'badge';

        const img = document.createElement('img');
        img.src = chrome.runtime.getURL('icons/icon16.svg');
        img.alt = '';
        badge.appendChild(img);

        const label = document.createElement('span');
        label.textContent = 'Selected';
        badge.appendChild(label);

        layer.appendChild(badge);

        document.documentElement.appendChild(host);

        this.host = host;
        this.layer = layer;
        this.badge = badge;

        this.startTracking();
    }

    setLoading(): void {
        if (this.host) {
            this.host.dataset.previewState = 'loading';
        }
    }

    setReady(): void {
        if (this.host) {
            this.host.dataset.previewState = 'ready';
        }
    }

    remove(): void {
        this.stopTracking();

        if (this.host && this.host.parentNode) {
            this.host.parentNode.removeChild(this.host);
        }
        this.host = null;
        this.layer = null;
        this.badge = null;
        this.root = null;
    }

    private startTracking(): void {
        if (!this.root || !this.host) return;

        // Queue geometry update via animation frame
        this.scheduleUpdate();

        // Scroll listener (capture phase for scroll events)
        this.scrollHandler = () => this.scheduleUpdate();
        window.addEventListener('scroll', this.scrollHandler, { capture: true, passive: true });

        // Window resize listener
        this.resizeHandler = () => this.scheduleUpdate();
        window.addEventListener('resize', this.resizeHandler, { passive: true });

        // ResizeObserver on root
        this.resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
        this.resizeObserver.observe(this.root);

        // Observe ancestor chain for resize
        let ancestor: HTMLElement | null = this.root.parentElement;
        while (ancestor && ancestor !== document.documentElement) {
            this.resizeObserver.observe(ancestor);
            ancestor = ancestor.parentElement;
        }

        // Throttled MutationObserver to catch layout shifts
        this.mutationObserver = new MutationObserver(() => this.scheduleUpdate());
        this.mutationObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
        });
    }

    private stopTracking(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }

        if (this.scrollHandler) {
            window.removeEventListener('scroll', this.scrollHandler, { capture: true });
            this.scrollHandler = null;
        }

        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
            this.resizeHandler = null;
        }

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }
    }

    private scheduleUpdate(): void {
        if (this.rafId !== null) return;

        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            this.updateGeometry();
        });
    }

    private updateGeometry(): void {
        if (!this.root || !this.layer) return;

        const rect = this.root.getBoundingClientRect();
        this.layer.style.top = `${rect.top}px`;
        this.layer.style.left = `${rect.left}px`;
        this.layer.style.width = `${rect.width}px`;
        this.layer.style.height = `${rect.height}px`;
    }
}
