// errors.ts - Custom error types for better UX

export class MarkdownizerError extends Error {
    public userMessage: string;
    public code?: number;

    constructor(message: string, userMessage: string, code?: number) {
        super(message);
        this.name = "MarkdownizerError";
        this.userMessage = userMessage;
        this.code = code;
    }
}

/**
 * Maps HTTP status codes to user-friendly messages
 */
export function mapHttpStatusToUserMessage(status: number, technicalMsg: string): string {
    switch (status) {
        case 400:
            return "The request was invalid. Try refreshing the page.";
        case 403:
            return "Unauthorized request. Try reinstalling the extension.";
        case 413:
            return "This page is too large to convert (Limit: 1MB).";
        case 429:
            return "Too many requests! Please wait a minute before trying again.";
        case 500:
        case 502:
        case 503:
        case 504:
            return "Our server is temporarily down. Please try again later.";
        default:
            return technicalMsg || "An unexpected error occurred.";
    }
}
