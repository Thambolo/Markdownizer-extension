type Status = 'idle' | 'loading' | 'success' | 'error';

interface StatusOrbProps {
  status: Status;
  handleConvert: () => void;
}

export function StatusOrb({ status, handleConvert }: StatusOrbProps) {
  return (
    <div class="relative group">
      {/* Ambient Glow/Wave Effect for Idle/Success State */}
      {(status === 'idle' || status === 'success') && (
        <>
          <div class="absolute inset-0 rounded-full bg-indigo-400/50 animate-ping opacity-100 duration-1000"></div>
          <div class="absolute -inset-4 rounded-full bg-indigo-400/20 blur-xl group-hover:bg-indigo-400/30 transition-all duration-500"></div>
        </>
      )}

      {status === 'loading' && (
        <div class="absolute inset-0 rounded-full border-2 border-indigo-500/50 border-t-indigo-400 animate-spin"></div>
      )}

      <button
        onClick={handleConvert}
        disabled={status === 'loading'}
        class={`relative z-10 w-32 h-32 rounded-full flex flex-col items-center justify-center transition-all duration-500 backdrop-blur-sm group/orb ${
          status === 'error'
            ? 'bg-red-500/10 text-red-400 ring-1 ring-red-500/50 hover:bg-red-500/20 hover:scale-105 cursor-pointer'
            : status === 'loading'
            ? 'bg-slate-900/80 text-indigo-200 ring-1 ring-indigo-500/50 cursor-wait'
            : 'bg-slate-900/90 text-indigo-400 ring-1 ring-indigo-500 hover:text-white hover:ring-indigo-400 hover:scale-105 hover:shadow-[0_0_25px_rgba(99,102,241,0.5)] cursor-pointer'
        }`}
      >
        {status === 'loading' ? (
          <span class="text-xs font-medium animate-pulse lowercase tracking-wide text-indigo-200">
            analyzing...
          </span>
        ) : status === 'error' ? (
          <div class="flex flex-col items-center gap-1">
            <svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span class="text-[10px] font-medium opacity-100">retry</span>
          </div>
        ) : (
          <div class="flex flex-col items-center gap-1.5 transform group-hover:-translate-y-0.5 transition-transform duration-300">
            <svg class="w-8 h-8 opacity-90 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span class="text-sm font-light text-indigo-100 group-hover:text-white transition-colors">
              start
            </span>
          </div>
        )}
      </button>
    </div>
  );
}
