import { getOrCreateUserID } from './identity';
import { mapHttpStatusToUserMessage } from './errors';

const API_URL = import.meta.env.VITE_API_URL;

interface ConvertSkeletonRequest {
    action: "convert_skeleton";
    payload: {
        html_skeleton: string;
        url: string;
        client_type: "extension";
        extraction_strategy: string;
    };
}

interface ConversionResponse {
    markdown_skeleton: string;
}

// Service Worker
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install' || details.reason === 'update') {
        await getOrCreateUserID();
    }
});

chrome.runtime.onMessage.addListener((request: ConvertSkeletonRequest, _sender, sendResponse) => {
    if (request.action !== "convert_skeleton") return;

    convertSkeleton(request.payload)
        .then((data) => sendResponse({ success: true, markdown_skeleton: data.markdown_skeleton }))
        .catch((err: unknown) => {
            console.error("Markdownizer API Error:", err);
            const message = err instanceof Error ? err.message : "Could not convert page.";
            sendResponse({ success: false, error: message });
        });

    return true;
});

async function convertSkeleton(payload: ConvertSkeletonRequest["payload"]): Promise<ConversionResponse> {
    const userID = await getOrCreateUserID();

    let response: Response;
    try {
        response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": userID
            },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        throw new Error("Could not reach server. Check your connection.");
    }

    if (!response.ok) {
        throw new Error(mapHttpStatusToUserMessage(response.status, response.statusText));
    }

    return response.json();
}
