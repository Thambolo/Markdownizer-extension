export const PREVIEW_PORT_NAME = 'markdownizer-capture-preview';

export type CaptureMode = 'smart' | 'full-page';

export type PreviewCommand =
    | { type: 'preview:show'; sessionId: string; captureMode?: CaptureMode }
    | { type: 'preview:inspect'; sessionId: string; captureMode?: CaptureMode; generation: number }
    | { type: 'preview:set-iframes'; sessionId: string; enabled: boolean }
    | { type: 'preview:loading'; sessionId: string }
    | { type: 'preview:ready'; sessionId: string }
    | { type: 'preview:hide'; sessionId: string };

export interface PreviewReadyRequest {
    action: 'preview_ready';
}

export interface ConvertPageRequest {
    action: 'convert_page';
    captureMode?: CaptureMode;
    includeIframes?: boolean;
}

export interface PreviewEligibilityMessage {
    type: 'preview:eligibility';
    sessionId: string;
    captureMode: CaptureMode;
    generation: number;
    hasEligibleIframes: boolean;
}
