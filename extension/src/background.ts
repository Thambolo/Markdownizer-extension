import { getOrCreateUserID } from './identity';
import { mapHttpStatusToUserMessage } from './errors';
import { collectCodeMirrorCaptureInMainWorld } from './codemirror-bridge';
import type { CodeMirrorDocumentCapture } from './codemirror-bridge';

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

interface ReadCodeMirrorCaptureRequest {
    action: 'read_codemirror_capture';
}

// ── Message routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((
    request: ConvertSkeletonRequest | ReadCodeMirrorCaptureRequest,
    sender,
    sendResponse: (response: unknown) => void,
) => {
    if (request.action === 'read_codemirror_capture') {
        handleReadCodeMirrorCapture(sender, sendResponse);
        return true;
    }

    if (request.action !== 'convert_skeleton') return;

    convertSkeleton((request as ConvertSkeletonRequest).payload)
        .then((data) => sendResponse({ success: true, markdown_skeleton: data.markdown_skeleton }))
        .catch((err: unknown) => {
            console.error('Markdownizer API Error:', err);
            const message = err instanceof Error ? err.message : 'Could not convert page.';
            sendResponse({ success: false, error: message });
        });

    return true;
});

async function handleReadCodeMirrorCapture(
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
): Promise<void> {
    const tabId = sender.tab?.id;
    if (tabId == null) {
        sendResponse({ success: false });
        return;
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'MAIN',
            func: collectCodeMirrorCaptureInMainWorld,
        });

        const capture: CodeMirrorDocumentCapture | undefined = results?.[0]?.result;
        sendResponse({ success: true, capture: capture ?? null });
    } catch {
        sendResponse({ success: false });
    }
}

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
