import { getBestContent } from './extractor';
import { skeletonize, rehydrate } from './logic';
import { getOrCreateUserID } from './identity';
import { mapHttpStatusToUserMessage } from './errors';

// Constants
const API_URL = import.meta.env.VITE_API_URL;

interface ConversionResponse {
    markdown_skeleton: string;
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
    const userID = await getOrCreateUserID();

    let response: Response;
    try {
        response = await fetch(API_URL, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "X-User-ID": userID
            },
            body: JSON.stringify({ html_skeleton: html, url: window.location.href })
        });
    } catch (e) {
        throw new Error("Could not reach server. Check your connection.");
    }

    if (!response.ok) {
        throw new Error(mapHttpStatusToUserMessage(response.status, response.statusText));
    }

    const data: ConversionResponse = await response.json();
    const markdown = rehydrate(data.markdown_skeleton, tokens);

    return { success: true, markdown };
}
