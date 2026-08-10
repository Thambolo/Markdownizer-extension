export function Header() {
  return (
    <header class="px-5 py-4 flex items-center justify-between border-b border-slate-800">
      <div class="flex items-center gap-3">
        <img src="/icons/icon16.svg" class="w-5 h-5 rounded-md opacity-100" alt="Logo" />
        <span class="text-sm font-medium tracking-wide text-slate-100">
          Markdownizer
        </span>
      </div>
    </header>
  );
}
