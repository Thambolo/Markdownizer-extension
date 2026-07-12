import { getBestContent, getReadabilityContent } from './extractor';
import { skeletonize, rehydrate } from './logic';
import { shouldUseReadability } from './payload';

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
    let extraction = getBestContent();
    if (!extraction) throw new Error('Could not find visible page content.');

    let skeleton = skeletonize(extraction.element);
    if (shouldUseReadability(skeleton.html)) {
        extraction = getReadabilityContent();
        if (!extraction) throw new Error('Could not reduce page content to the supported size.');
        skeleton = skeletonize(extraction.element);
    }

    if (shouldUseReadability(skeleton.html)) {
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

    const markdown = rehydrate(response.markdown_skeleton, tokens);

    return { success: true, markdown };
}
