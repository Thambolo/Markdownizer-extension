import { useCallback, useRef, useState } from 'preact/hooks';
import type { CaptureMode } from '../../shared/preview-protocol';

/** Capture-mode state with a shared ref so session and conversion hooks always
 * read the mode that was set by the last toggle. */
export function useCaptureMode(defaultMode: CaptureMode): [CaptureMode, (m: CaptureMode) => void, { current: CaptureMode }] {
    const [mode, setMode] = useState<CaptureMode>(defaultMode);
    const ref = useRef<CaptureMode>(defaultMode);

    const setCaptureMode = useCallback((next: CaptureMode) => {
        ref.current = next;
        setMode(next);
    }, []);

    return [mode, setCaptureMode, ref];
}
