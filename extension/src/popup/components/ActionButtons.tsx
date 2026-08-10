interface ActionButtonsProps {
  copied: boolean;
  downloaded: boolean;
  imagesActive: boolean;
  bundling: boolean;
  handleCopy: () => void;
  handleDownload: () => void;
  handleDownloadZip: () => void;
}

function DownloadIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}

export function ActionButtons({ copied, downloaded, imagesActive, bundling, handleCopy, handleDownload, handleDownloadZip }: ActionButtonsProps) {
  return (
    <div class="flex flex-col gap-3 w-full animate-in slide-in-from-bottom-4 duration-500">
      <button
        onClick={handleCopy}
        class={`w-full py-3 font-medium rounded-xl border transition-all flex items-center justify-center gap-2 ${
          copied
            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
            : 'bg-indigo-600/10 border-indigo-400/50 text-indigo-200 hover:bg-indigo-600/20 hover:border-indigo-400 hover:text-white'
        }`}
      >
        {copied ? (
          <>
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span>Copied to Clipboard</span>
          </>
        ) : (
          'Copy to Clipboard'
        )}
      </button>

      {downloaded ? (
        <button class="w-full py-3 font-medium rounded-xl border transition-all flex items-center justify-center gap-2 bg-emerald-500/20 border-emerald-500/50 text-emerald-300">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>Downloaded!</span>
        </button>
      ) : imagesActive ? (
        <div class="flex w-full rounded-xl border border-slate-500 bg-slate-800 overflow-hidden">
          <button
            onClick={handleDownload}
            disabled={bundling}
            class={`flex-1 py-3 font-medium transition-all flex items-center justify-center gap-2 text-slate-300 hover:bg-slate-700 hover:text-white ${
              bundling ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            <DownloadIcon />
            <span>.md</span>
          </button>
          <div class="w-px bg-slate-600" aria-hidden="true" />
          <button
            onClick={handleDownloadZip}
            disabled={bundling}
            class={`flex-1 py-3 font-medium transition-all flex items-center justify-center gap-2 text-indigo-200 hover:bg-indigo-600/20 hover:text-white ${
              bundling ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            {bundling ? (
              <>
                <span
                  class="inline-block w-4 h-4 border-2 border-indigo-300 border-t-transparent rounded-full animate-spin"
                  aria-hidden="true"
                />
                <span>Bundling…</span>
              </>
            ) : (
              <>
                <DownloadIcon />
                <span>.md + images</span>
              </>
            )}
          </button>
        </div>
      ) : (
        <button
          onClick={handleDownload}
          class="w-full py-3 font-medium rounded-xl border transition-all flex items-center justify-center gap-2 bg-slate-800 border-slate-500 text-slate-300 hover:bg-slate-700 hover:text-white hover:border-slate-400"
        >
          <DownloadIcon />
          <span>.md</span>
        </button>
      )}
    </div>
  );
}
