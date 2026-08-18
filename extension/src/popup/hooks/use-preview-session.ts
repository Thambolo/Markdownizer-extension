import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { CaptureMode, PreviewEligibilityMessage } from '../../shared/preview-protocol';
import { isSupportedPageUrl, openPreviewSession, type PreviewSession } from '../preview-session';
import {
    applyIframeEligibility,
    initialIframeOptionState,
    setIframePreference,
    isIframeIncluded,
    type IframeOptionState,
} from '../iframe-option';

/** Preview session lifecycle + eligibility: opens the session on mount,
 * drives show/inspect/set-include-iframes from the footer toggles, and owns
 * the iframe-option / images-eligible state (mirroring the App's callbacks
 * into the conversion refs via onIframeOptionChange/onImagesEligibleChange). */
export function usePreviewSession(options: {
    captureModeRef: { current: CaptureMode };
    previewEnabled: boolean;
    setPreviewEnabled: (next: boolean) => void;
    onIframeOptionChange: (next: IframeOptionState) => void;
    onImagesEligibleChange: (eligible: boolean) => void;
}) {
    const { captureModeRef, previewEnabled, setPreviewEnabled, onIframeOptionChange, onImagesEligibleChange } = options;
    const sessionRef = useRef<PreviewSession | null>(null);
    const inspectionGenerationRef = useRef(0);
    const [iframeOption, setIframeOption] = useState<IframeOptionState>(initialIframeOptionState);
    const iframeOptionRef = useRef<IframeOptionState>(initialIframeOptionState());
    const [imagesEligible, setImagesEligible] = useState(false);
    const [previewWarning, setPreviewWarning] = useState('');
    const previewEnabledRef = useRef(previewEnabled);
    previewEnabledRef.current = previewEnabled;

    const requestIframeInspection = useCallback((session: PreviewSession, mode: CaptureMode): void => {
        const generation = inspectionGenerationRef.current + 1;
        inspectionGenerationRef.current = generation;
        // The inspect payload carries the active include-iframes choice so the
        // content script only counts iframe images when they will be captured.
        session.inspect(mode, generation, isIframeIncluded(iframeOptionRef.current));
    }, []);

    const handleIframeEligibility = useCallback((message: PreviewEligibilityMessage): void => {
        if (message.captureMode !== captureModeRef.current || message.generation !== inspectionGenerationRef.current) return;

        const prev = isIframeIncluded(iframeOptionRef.current);
        const next = applyIframeEligibility(iframeOptionRef.current, message.hasEligibleIframes);
        iframeOptionRef.current = next;
        setIframeOption(next);
        onIframeOptionChange(next);
        const now = isIframeIncluded(next);
        if (previewEnabledRef.current && sessionRef.current && prev !== now) {
            sessionRef.current.setIncludeIframes(now);
        }
        if (sessionRef.current && prev !== now) {
            // Auto-inclusion flipped iframes off -> on (or the reverse): the
            // content script's last eligibility was computed under the old
            // include-iframes choice, so re-inspect under the new one. Not gated
            // on preview being enabled — the session stays live for eligibility
            // (mirror F4). Terminates: the re-inspection's eligibility returns
            // with prev === now, so no further re-inspection.
            inspectionGenerationRef.current = 0;
            requestIframeInspection(sessionRef.current, message.captureMode);
        }
        setImagesEligible(message.hasImages);
        onImagesEligibleChange(message.hasImages);
    }, [requestIframeInspection, onIframeOptionChange, onImagesEligibleChange, captureModeRef]);

    // Read preview preference and open session on mount
    useEffect(() => {
        let cancelled = false;
        let unsubscribe: (() => void) | null = null;

        const initPreview = async () => {
            try {
                const result = await chrome.storage.local.get(['capturePreviewEnabled']);
                // Treat only explicit false as disabled; missing value = enabled
                const enabled = result.capturePreviewEnabled !== false;
                if (cancelled) return;
                setPreviewEnabled(enabled);
                previewEnabledRef.current = enabled;

                // Get the active tab
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.id || !isSupportedPageUrl(tab.url)) return;
                if (cancelled) return;

                const session = await openPreviewSession(tab.id);
                if (cancelled) {
                    session.disconnect();
                    return;
                }
                sessionRef.current = session;
                unsubscribe = session.onEligibility(handleIframeEligibility);
                if (enabled) session.show(captureModeRef.current);
                requestIframeInspection(session, captureModeRef.current);
            } catch (err) {
                if (cancelled) return;
                setPreviewWarning('Preview unavailable on this page');
            }
        };

        initPreview();

        return () => {
            cancelled = true;
            unsubscribe?.();
            if (sessionRef.current) {
                sessionRef.current.disconnect();
                sessionRef.current = null;
            }
        };
        // Mount-only effect: runs once per popup open. All captured values are
        // refs and state setters; the session and handlers are intentionally
        // bound to the popup's lifetime, not to dependency changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const togglePreview = async (e: Event) => {
        const target = e.target as HTMLInputElement;
        const newValue = target.checked;
        setPreviewEnabled(newValue);
        previewEnabledRef.current = newValue;
        chrome.storage.local.set({ capturePreviewEnabled: newValue });

        if (!newValue) {
            // Turning off: hide the preview immediately
            if (sessionRef.current) {
                sessionRef.current.hide();
            }
        } else {
            // Turning on: establish session and show
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.id || !isSupportedPageUrl(tab.url)) return;

                // Create a session if none exists
                if (!sessionRef.current) {
                    const session = await openPreviewSession(tab.id);
                    sessionRef.current = session;
                    session.onEligibility(handleIframeEligibility);
                }

                sessionRef.current.show(captureModeRef.current);
                requestIframeInspection(sessionRef.current, captureModeRef.current);
                setPreviewWarning('');
            } catch {
                setPreviewWarning('Preview unavailable on this page');
            }
        }
    };

    const toggleCaptureFullPage = (e: Event) => {
        const target = e.target as HTMLInputElement;
        const newValue = target.checked;
        const newMode: CaptureMode = newValue ? 'full-page' : 'smart';
        captureModeRef.current = newMode;

        // If preview is enabled and session exists, show with new mode immediately
        if (previewEnabledRef.current && sessionRef.current) {
            sessionRef.current.show(newMode);
            sessionRef.current.setIncludeIframes(isIframeIncluded(iframeOptionRef.current));
        }
        if (sessionRef.current) {
            inspectionGenerationRef.current = 0;
            requestIframeInspection(sessionRef.current, newMode);
        }
    };

    const toggleIncludeIframes = (e: Event) => {
        const target = e.target as HTMLInputElement;
        const next = setIframePreference(iframeOptionRef.current, target.checked ? 'include' : 'exclude');
        iframeOptionRef.current = next;
        setIframeOption(next);
        onIframeOptionChange(next);
        // The session stays open for eligibility even when visual preview is
        // disabled, so re-inspection must not be gated on preview being enabled.
        if (sessionRef.current) {
            sessionRef.current.setIncludeIframes(isIframeIncluded(next));
            inspectionGenerationRef.current = 0;
            requestIframeInspection(sessionRef.current, captureModeRef.current);
        }
    };

    return {
        sessionRef,
        iframeOption,
        imagesEligible,
        previewWarning,
        setPreviewWarning,
        togglePreview,
        toggleCaptureFullPage,
        toggleIncludeIframes,
    };
}
