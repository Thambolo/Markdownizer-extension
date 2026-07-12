export const MAX_SKELETON_BYTES = 1_048_576;

export function skeletonSize(html: string): number {
    return new TextEncoder().encode(html).byteLength;
}

export function shouldUseReadability(html: string): boolean {
    return skeletonSize(html) > MAX_SKELETON_BYTES;
}
