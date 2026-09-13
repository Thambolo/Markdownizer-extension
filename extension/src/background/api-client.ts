// api-client.ts — backend conversion requests (P6): skeleton-in → markdown
// skeleton out, with the user identity header and HTTP-status UX mapping.
// The readable page text never leaves the browser: only the anonymous
// structural skeleton is POSTed (privacy by design).

import { getOrCreateUserID } from './identity';
import { mapHttpStatusToUserMessage } from './errors';
import type { ConvertSkeletonMessage } from '../shared/messages';

const API_URL = import.meta.env.VITE_API_URL;

interface ConversionResponse {
    markdown_skeleton: string;
}

export async function convertSkeleton(payload: ConvertSkeletonMessage['payload']): Promise<ConversionResponse> {
    const userID = await getOrCreateUserID();

    let response: Response;
    try {
        response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-User-ID': userID,
            },
            body: JSON.stringify(payload),
        });
    } catch (e) {
        throw new Error('Could not reach server. Check your connection.');
    }

    if (!response.ok) {
        throw new Error(mapHttpStatusToUserMessage(response.status, response.statusText));
    }

    return response.json();
}