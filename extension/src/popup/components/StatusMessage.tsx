type Status = 'idle' | 'loading' | 'success' | 'error';

interface StatusMessageProps {
  status: Status;
  markdownLength: number;
  error: string;
}

export function StatusMessage({ status, markdownLength, error }: StatusMessageProps) {
  return (
    <div class="text-center space-y-1 h-12 pt-2 flex flex-col items-center justify-start">
      <h2
        class={`text-sm font-light transition-all flex items-center justify-center gap-2 ${
          status === 'success'
            ? 'text-emerald-300 font-medium px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-500/40'
            : status === 'error'
            ? 'text-red-300 font-medium'
            : 'text-indigo-200'
        }`}
      >
        {status === 'idle' && 'Ready to capture'}
        {status === 'loading' && 'Processing content...'}
        {status === 'success' && (
          <>
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span>Content extracted</span>
          </>
        )}
        {status === 'error' && 'Something went wrong'}
      </h2>

      <p class={`text-[10px] font-mono mt-1 ${status === 'error' ? 'text-red-400' : 'text-slate-400'}`}>
        {status === 'success' && `${markdownLength} chars`}
        {status === 'error' && error}
      </p>
    </div>
  );
}
