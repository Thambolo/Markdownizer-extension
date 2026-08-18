/** Create a blob URL for `blob`, click an anchor to download it as
 * `filename`, and clean up. Callers own `.md` suffixing. */
export function downloadBlob(blob: Blob, filename: string, revokeDelayMs = 0): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    if (revokeDelayMs > 0) setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
    else URL.revokeObjectURL(url);
}
