export const PREVIEW_PORT_NAME = 'markdownizer-capture-preview';

export type PreviewCommand =
    | { type: 'preview:show'; sessionId: string }
    | { type: 'preview:loading'; sessionId: string }
    | { type: 'preview:ready'; sessionId: string }
    | { type: 'preview:hide'; sessionId: string };

export interface PreviewReadyRequest {
    action: 'preview_ready';
}
