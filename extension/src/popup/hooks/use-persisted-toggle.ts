import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export function usePersistedToggle(key: string, defaultValue: boolean): [boolean, (next: boolean) => void] {
    const [value, setValue] = useState(defaultValue);
    const ref = useRef(value);
    ref.current = value;

    useEffect(() => {
        let cancelled = false;
        chrome.storage.local.get([key]).then((result) => {
            if (cancelled || result[key] === undefined) return;
            const next = result[key] as boolean;
            setValue(next);
            ref.current = next;
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [key]);

    const toggle = useCallback((next: boolean) => {
        ref.current = next;
        setValue(next);
        chrome.storage.local.set({ [key]: next }).catch(() => {});
    }, [key]);

    return [value, toggle];
}
