import { getBestContent } from './extractor';
import { skeletonize, rehydrate } from './logic';

interface BackgroundConversionResponse {
    success: boolean;
    markdown_skeleton?: string;
    error?: string;
}

/**
 * Main Entry Point: Listen for messages from the popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "convert_page") {
        processPage().then(sendResponse).catch((err) => {
            console.error("Markdownizer Error:", err);
            // Default to technical message if userMessage is not set (for unexpected errors)
            sendResponse({ success: false, error: err.message });
        });
        return true; // Keep channel open for async response
    }
});

async function processPage() {
    const extraction = getBestContent();
    if (!extraction) {
        throw new Error("Could not find article content on this page.");
    }

    const { html, tokens } = skeletonize(extraction.element);
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

    const markdown = rehydrate(response.markdown_skeleton, tokens);

    return { success: true, markdown };
}
