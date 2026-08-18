const BUTTON_TYPES = new Set(['button', 'submit', 'reset', 'image']);
const REDACTED_TYPES = new Set(['password', 'hidden']);
const CHECKABLE_TYPES = new Set(['checkbox', 'radio']);

export function serializeNativeControls(sourceRoot: HTMLElement, cloneRoot: HTMLElement): void {
    const sourceControls = Array.from(sourceRoot.querySelectorAll<HTMLElement>('button,input,select,textarea'));
    const cloneControls = Array.from(cloneRoot.querySelectorAll<HTMLElement>('button,input,select,textarea'));
    if (sourceControls.length !== cloneControls.length) return;

    sourceControls.forEach((source, index) => {
        const clone = cloneControls[index];
        const marker = source.ownerDocument.createElement('mdz-control');
        const type = controlType(source);
        const isInput = source.tagName === 'INPUT';
        const isSelect = source.tagName === 'SELECT';
        const isTextarea = source.tagName === 'TEXTAREA';
        const isButton = source.tagName === 'BUTTON';

        if (isInput && REDACTED_TYPES.has(type)) {
            setMarker(marker, type, type, 'redacted');
        } else if (isInput && CHECKABLE_TYPES.has(type)) {
            const input = source as HTMLInputElement;
            setMarker(marker, type, type, input.checked ? 'checked' : 'unchecked');
        } else if (isInput && type === 'file') {
            const names = Array.from((source as HTMLInputElement).files ?? [], (file) => file.name);
            setMarker(marker, 'file', type, 'files', names.length ? `files: ${names.map(quote).join(', ')}` : 'no files selected');
        } else if (isSelect) {
            const selected = Array.from((source as HTMLSelectElement).selectedOptions, (option) => option.text).join(', ');
            setMarker(marker, 'select', type, 'selected', `selected: ${quote(selected)}`);
        } else if (isTextarea) {
            const textarea = source as HTMLTextAreaElement;
            setMarker(marker, 'textarea', type, 'value', textValue(textarea.placeholder, textarea.value));
        } else if (isButton || (isInput && BUTTON_TYPES.has(type))) {
            setMarker(marker, 'button', type, 'label', `label: ${quote(buttonLabel(source, type))}`);
        } else if (isInput) {
            const input = source as HTMLInputElement;
            setMarker(marker, 'input', type, 'value', textValue(input.placeholder, input.value));
        }

        clone.replaceWith(marker);
    });
}

function controlType(control: HTMLElement): string {
    if (control.tagName === 'INPUT' || control.tagName === 'BUTTON') return (control as HTMLInputElement | HTMLButtonElement).type;
    return control.tagName.toLowerCase();
}

function setMarker(marker: HTMLElement, kind: string, type: string, state: string, text?: string): void {
    marker.setAttribute('data-kind', kind);
    marker.setAttribute('data-type', type);
    marker.setAttribute('data-state', state);
    if (text) marker.textContent = text;
}

function textValue(placeholder: string, value: string): string {
    return placeholder ? `placeholder: ${quote(placeholder)}; value: ${quote(value)}` : `value: ${quote(value)}`;
}

function buttonLabel(control: HTMLElement, type: string): string {
    const value = control.tagName === 'INPUT' ? (control as HTMLInputElement).value : '';
    return control.textContent?.trim() || control.getAttribute('aria-label') || value || control.getAttribute('alt') || type;
}

function quote(value: string): string {
    return JSON.stringify(value);
}
