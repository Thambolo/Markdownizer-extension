import '../preview/content-preview.css';
import { ContentPreview } from '../preview/content-preview';
import { PREVIEW_PORT_NAME } from '../shared/preview-protocol';
import { dispatchMessage, registerMessageHandler } from '../shared/messages';
import type { ConvertPageMessage } from '../shared/messages';
import { processPage } from './conversion-pipeline';
import { EligibilityWatcher } from './eligibility-watcher';
import {
    PreviewPortController,
    isPreviewHostMutation,
    normalizeCaptureMode,
    normalizeIncludeIframes,
} from './preview-port';

// ── Preview Protocol ──────────────────────────────────────────────────────────

const preview = new ContentPreview();

let nextGeneration = 0;

/**
 * Each preview-port connection gets an eligibility watcher (its callbacks
 * delegate to the controller's live state) and a PreviewPortController that
 * wires itself to the port. Only the most recent connection owns the overlay;
 * stale ports are ignored by the controller's generation guards.
 */
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PREVIEW_PORT_NAME) return;

    const generation = nextGeneration++;
    // eslint-disable-next-line prefer-const -- watcher callbacks close over the binding before assignment; only read after wiring completes
    let controller: PreviewPortController;
    const watcher = new EligibilityWatcher({
        getRoot: () => controller.getRoot(),
        postEligibility: () => controller.postEligibility(),
        isCaptureRelevantMutation: (record) => controller.isCaptureRelevantMutation(record),
        isPreviewHostMutation,
    });
    controller = new PreviewPortController(port, generation, watcher, preview);
});

// ── Page Conversion (popup) ───────────────────────────────────────────────────

registerMessageHandler('preview_ready', (_request, _sender, sendResponse) => {
    sendResponse({ success: true });
    return false; // Synchronous response
});

registerMessageHandler('convert_page', (request, _sender, sendResponse) => {
    const msg = request as ConvertPageMessage;
    processPage(
        normalizeCaptureMode(msg.captureMode),
        normalizeIncludeIframes(msg.includeIframes),
    ).then(sendResponse).catch((err) => {
        console.error("Markdownizer Error:", err);
        // Default to technical message if userMessage is not set (for unexpected errors)
        sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open for async response
});

/**
 * Main Entry Point: Listen for messages from the popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => dispatchMessage(request, sender, sendResponse));
