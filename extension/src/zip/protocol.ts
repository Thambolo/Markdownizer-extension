export type ZipPhase = 'fetch' | 'build';
export interface ActiveZipBuildState { buildId?: string; phase?: ZipPhase; fetched?: number; total?: number; startedAt?: number; }
export interface ZipDoneMetadata { downloaded: 'zip' | 'md'; filename: string; totalImages: number; bundledImages: number; skippedImages: number; }
export type ZipBuildProgress = { phase: 'fetch'; fetched: number; total: number } | { phase: 'build' };

export function normalizeZipPhase(phase: unknown): ZipPhase {
    return phase === 'build' ? 'build' : 'fetch';
}

export function withZipDoneDefaults(meta: Partial<ZipDoneMetadata>): ZipDoneMetadata {
    return {
        downloaded: meta.downloaded ?? 'md',
        filename: meta.filename ?? 'download',
        totalImages: meta.totalImages ?? 0,
        bundledImages: meta.bundledImages ?? 0,
        skippedImages: meta.skippedImages ?? 0,
    };
}
