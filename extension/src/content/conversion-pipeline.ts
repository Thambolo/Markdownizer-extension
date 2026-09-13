import { getReadabilityContent } from '../extraction/extractor';
import type { CodeMirrorDocumentCapture } from '../extraction/codemirror-bridge';
import { skeletonize, rehydrateMarkdown } from '../skeleton/skeletonizer';
import { shouldUseReadability } from './payload';
import { getCaptureStrategy } from './strategies';
import type { CaptureMode } from '../shared/preview-protocol';

interface BackgroundConversionResponse {
    success: boolean;
    markdown_skeleton?: string;
    error?: string;
}

export async function requestCodeMirrorCapture(): Promise<CodeMirrorDocumentCapture | null> {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'read_codemirror_capture' });
        if (response?.success && response.capture) {
            return response.capture as CodeMirrorDocumentCapture;
        }
    } catch {
        // Service worker unavailable or execution failed — fall back gracefully
    }
    return null;
}

export async function processPage(captureMode: CaptureMode, includeIframes = false) {
    let codeMirrorCapture: CodeMirrorDocumentCapture | null = null;
    // Capture page-owned editor models when needed. Iframe inclusion is
    // required to discover editors inside frames; the direct selector covers
    // editors in the main document without adding a bridge call for ordinary pages.
    if (includeIframes || document.querySelector('.CodeMirror')) {
        codeMirrorCapture = await requestCodeMirrorCapture();
    }

    let extraction = getCaptureStrategy(captureMode).extract({ includeIframes, codeMirrorCapture: codeMirrorCapture ?? undefined });
    if (!extraction) throw new Error('Could not find visible page content.');

    let skeleton = skeletonize(extraction.element);
    if (includeIframes && shouldUseReadability(skeleton.html)) {
        throw new Error('The page and included iframe content are too large to convert. Turn off Include iframes and try again.');
    }
    if (shouldUseReadability(skeleton.html) && captureMode === 'full-page') {
        throw new Error('The full page is too large to convert. Turn off Capture full page to use Smart selection.');
    }

    if (shouldUseReadability(skeleton.html) && captureMode === 'smart') {
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