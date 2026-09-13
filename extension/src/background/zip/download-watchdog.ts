// download-watchdog.ts — download-appearance verification for finalized ZIP
// builds (P6). The offscreen document downloads the payload via a blob-anchor
// click, which reports no failure: a policy-blocked download would otherwise
// look like success. This watchdog verifies a download item actually appeared
// after a finalized build and broadcasts zip:error when none does.

const DOWNLOAD_WATCH_MS = 10_000;
const DOWNLOAD_POLL_MS = 1_000;
/** Download ids that existed before the first build's anchor click in this
 * worker instance. Snapshot ONCE per instance: a per-arrival refresh would
 * race with an overlapping build (its already-clicked item could be absorbed
 * into the snapshot, causing a false zip:error). Every anchor click happens
 * after its own arrival, which is after the first arrival, so every build's
 * item counts as new. */
let knownDownloadIds = new Set<number>();
let downloadSnapshotTaken = false;
/** Single global watchdog: a second arm supersedes (the popup's buildId guard
 * drops any mis-attributed error). */
let downloadWatchTimer: ReturnType<typeof setTimeout> | null = null;

// Module-private helper: the coordinator's broadcast helper stays in the
// coordinator, and this module must not import from it (import cycle) — the
// watchdog only ever needs its own zip:error broadcasts.
const broadcast = (message: Record<string, unknown>): void => {
    chrome.runtime.sendMessage(message).catch(() => {});
};

/** Baseline of pre-existing download ids; awaited before the first build
 * dispatches to the offscreen. No-op when the API is missing (e.g. the dist
 * smoke's mocked chrome) or after the first snapshot. */
export async function snapshotDownloadIds(): Promise<void> {
    if (downloadSnapshotTaken) return;
    if (!chrome.downloads?.search) return;
    try {
        const items = await chrome.downloads.search({});
        knownDownloadIds = new Set(items.map((i) => i.id));
        downloadSnapshotTaken = true;
    } catch {
        // Leave the snapshot empty; the watchdog treats every item as new.
    }
}

/** Poll for a new (non-interrupted) download item; broadcast zip:error when
 * none appears within the window. Success precedence: any new item that is
 * complete/in_progress wins over unrelated interrupted items. */
export function watchDownloadAppearance(buildId: string): void {
    if (!chrome.downloads?.search) return;
    if (downloadWatchTimer !== null) return;
    const deadline = Date.now() + DOWNLOAD_WATCH_MS;
    const poll = (): void => {
        if (Date.now() >= deadline) {
            downloadWatchTimer = null;
            broadcast({ type: 'zip:error', buildId, error: 'The download failed. Try again.' });
            return;
        }
        chrome.downloads
            .search({})
            .then((items) => {
                const fresh = items.filter((i) => !knownDownloadIds.has(i.id));
                if (fresh.some((i) => i.state === 'complete' || i.state === 'in_progress')) {
                    downloadWatchTimer = null; // an item is downloading: success
                    return;
                }
                if (fresh.some((i) => i.state === 'interrupted')) {
                    downloadWatchTimer = null;
                    broadcast({ type: 'zip:error', buildId, error: 'The download failed. Try again.' });
                    return;
                }
                downloadWatchTimer = setTimeout(poll, DOWNLOAD_POLL_MS);
            })
            .catch(() => {
                // Transient API error: keep polling, never a false error.
                downloadWatchTimer = setTimeout(poll, DOWNLOAD_POLL_MS);
            });
    };
    poll();
}