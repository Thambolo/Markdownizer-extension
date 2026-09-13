import type { CaptureMode } from './preview-protocol';

export interface ConvertPageMessage { action: 'convert_page'; captureMode?: CaptureMode; includeIframes?: boolean; }
export interface PreviewReadyMessage { action: 'preview_ready'; }
export interface ConvertSkeletonMessage {
    action: 'convert_skeleton';
    payload: { html_skeleton: string; url: string; client_type: 'extension'; extraction_strategy: string; };
}
export interface BuildZipMessage { action: 'build_zip'; buildId: string; payload: { markdown: string; title: string; sourceUrl: string | null; }; }
export interface ZipStatusMessage { action: 'zip:status'; buildId: string; }
export interface ReadCodeMirrorCaptureMessage { action: 'read_codemirror_capture'; }

export interface ZipProgressBroadcast { type: 'zip:progress'; buildId: string; phase?: string; fetched?: number; total?: number; }
export interface ZipDoneBroadcast { type: 'zip:done'; buildId: string; downloaded: 'zip' | 'md'; filename: string; totalImages: number; bundledImages: number; skippedImages: number; }
export interface ZipErrorBroadcast { type: 'zip:error'; buildId: string; error: string; }
export interface ZipCompletedBroadcast {
    type: 'zip:completed'; buildId: string; ok: boolean;
    downloaded?: 'zip' | 'md'; filename?: string; totalImages?: number; bundledImages?: number; skippedImages?: number; error?: string;
}
export interface OffscreenBuildMessage { type: 'offscreen:build'; buildId: string; payload: { markdown: string; title: string; sourceUrl: string | null; }; }

export type RuntimeMessage =
    | ConvertPageMessage | PreviewReadyMessage | ConvertSkeletonMessage | BuildZipMessage | ZipStatusMessage
    | ReadCodeMirrorCaptureMessage | ZipProgressBroadcast | ZipDoneBroadcast | ZipErrorBroadcast
    | ZipCompletedBroadcast | OffscreenBuildMessage;

export type MessageHandler = (
    request: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
) => boolean | void;

const handlers = new Map<string, MessageHandler>();

export function registerMessageHandler(key: string, handler: MessageHandler): void {
    handlers.set(key, handler);
}

/** Route a runtime message to its registered handler. Returns the handler's
 * return value (true keeps the channel open); undefined when unroutable. */
export function dispatchMessage(
    request: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
): boolean | undefined {
    if (request === null || typeof request !== 'object') return undefined;
    const rec = request as Record<string, unknown>;
    const key = typeof rec.type === 'string' ? rec.type : typeof rec.action === 'string' ? rec.action : undefined;
    if (key === undefined) return undefined;
    const handler = handlers.get(key);
    if (!handler) return undefined;
    return handler(request, sender, sendResponse) ?? undefined;
}
