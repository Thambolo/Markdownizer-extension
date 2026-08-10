export interface ToggleProps {
    id: string;
    label: string;
    checked: boolean;
    onChange: (event: Event) => void;
    description?: string;
    disabled?: boolean;
}

export function Toggle({ id, label, checked, onChange, description, disabled }: ToggleProps): JSX.Element {
    return (
        <label
            htmlFor={id}
            class={`flex w-full items-center justify-between gap-4 ${
                disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
            }`}
        >
            <span class="text-left">
                <span class="block text-xs text-slate-400 hover:text-slate-300 transition-colors">{label}</span>
                {description && <span class="mt-0.5 block text-[11px] text-slate-500">{description}</span>}
            </span>
            <span class="relative inline-flex shrink-0 items-center">
                <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    onChange={onChange}
                    disabled={disabled}
                    class="peer sr-only"
                />
                <span
                    aria-hidden="true"
                    class={`w-9 h-5 rounded-full transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-300 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900 ${
                        checked
                            ? 'bg-indigo-500'
                            : 'bg-slate-700'
                    }`}
                />
                <span
                    aria-hidden="true"
                    class={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-150 motion-reduce:transition-none ${
                        checked ? 'translate-x-4' : 'translate-x-0'
                    }`}
                />
            </span>
        </label>
    );
}
