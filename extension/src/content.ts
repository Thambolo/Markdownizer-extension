import './content-preview.css';
import { getContentForMode, getReadabilityContent } from './extractor';
import { skeletonize, rehydrateMarkdown } from './logic';
import { shouldUseReadability } from './payload';
import { ContentPreview } from './content-preview';
import {
    PREVIEW_PORT_NAME,
    type CaptureMode,
    type PreviewCommand,
} from './preview-protocol';

interface BackgroundConversionResponse {
    success: boolean;
    markdown_skeleton?: string;
    error?: string;
}

// ── Preview Protocol ──────────────────────────────────────────────────────────

const preview = new ContentPreview();

interface OwnerState {
    port: chrome.runtime.Port;
    sessionId: string;
    generation: number;
}

let nextGeneration = 0;
let currentOwner: OwnerState | null = null;

function normalizeCaptureMode(value: unknown): CaptureMode {
    return value === 'full-page' ? 'full-page' : 'smart';
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PREVIEW_PORT_NAME) return;

    const generation = nextGeneration++;

    const handleMessage = (msg: unknown) => {
        const cmd = msg as PreviewCommand;

        switch (cmd.type) {
            case 'preview:show': {
                const extraction = getContentForMode(normalizeCaptureMode(cmd.captureMode));
                if (!extraction) {
                    port.postMessage({
                        success: false,
                        error: 'No visible source element found.',
                    });
                    return;
                }
                currentOwner = { port, sessionId: cmd.sessionId, generation };
                preview.show(extraction.sourceElement);
                port.postMessage({ success: true });
                break;
            }
            default: {
                // Only the current generation may change state or remove
                if (!currentOwner || currentOwner.generation !== generation) return;

                if (cmd.type === 'preview:loading') {
                    preview.setLoading();
                } else if (cmd.type === 'preview:ready') {
                    preview.setReady();
                } else if (cmd.type === 'preview:hide') {
                    preview.remove();
                    currentOwner = null;
                }
                break;
            }
        }
    };

    const handleDisconnect = () => {
        port.onMessage.removeListener(handleMessage);
        // Only the current generation cleans up
        if (currentOwner && currentOwner.generation === generation) {
            preview.remove();
            currentOwner = null;
        }
    };

    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
});

// ── Page Conversion (popup) ───────────────────────────────────────────────────

/**
 * Main Entry Point: Listen for messages from the popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "preview_ready") {
        sendResponse({ success: true });
        return false; // Synchronous response
    }

    if (request.action === "convert_page") {
        processPage(normalizeCaptureMode(request.captureMode)).then(sendResponse).catch((err) => {
            console.error("Markdownizer Error:", err);
            // Default to technical message if userMessage is not set (for unexpected errors)
            sendResponse({ success: false, error: err.message });
        });
        return true; // Keep channel open for async response
    }
});

async function processPage(captureMode: CaptureMode) {
    let extraction = getContentForMode(captureMode);
    if (!extraction) throw new Error('Could not find visible page content.');

    let skeleton = skeletonize(extraction.element);
    if (shouldUseReadability(skeleton.html) && captureMode === 'full-page') {
        throw new Error('The full page is too large to convert. Turn off Capture full page to use Smart selection.');
    }

    if (shouldUseReadability(skeleton.html)) {
        extraction = getReadabilityContent();
        if (!extraction) throw new Error('Could not reduce page content to the supported size.');
        skeleton = skeletonize(extraction.element);
    }

    if (captureMode === 'smart' && shouldUseReadability(skeleton.html)) {
        throw new Error('This page is too large to convert.');
    }

    const { html, tokens } = skeleton;
    const response: BackgroundConversionResponse = await chrome.runtime.sendMessage({
        action: "convert_skeleton",
        payload: {
            html_skeleton: html,
            url: window.location.href,
            client_type: "extension",
            extraction_strategy: extraction.strategy
        }
    });

    if (!response?.success || !response.markdown_skeleton) {
        throw new Error(response?.error || "Could not convert page.");
    }

    const markdown = rehydrateMarkdown(response.markdown_skeleton, tokens);

    return { success: true, markdown };
}
