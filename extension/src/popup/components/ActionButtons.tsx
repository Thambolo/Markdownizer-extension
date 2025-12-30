interface ActionButtonsProps {
  copied: boolean;
  downloaded: boolean;
  handleCopy: () => void;
  handleDownload: () => void;
}

export function ActionButtons({ copied, downloaded, handleCopy, handleDownload }: ActionButtonsProps) {
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

      <button
        onClick={handleDownload}
        class={`w-full py-3 font-medium rounded-xl border transition-all flex items-center justify-center gap-2 ${
          downloaded
            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
            : 'bg-slate-800 border-slate-500 text-slate-300 hover:bg-slate-700 hover:text-white hover:border-slate-400'
        }`}
      >
        {downloaded ? (
          <>
             <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span>Downloaded!</span>
          </>
        ) : (
          'Download .md'
        )}
      </button>
    </div>
  );
}
