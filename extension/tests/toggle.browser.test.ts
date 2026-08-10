import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { h, render } from 'preact';
import { Toggle } from '../src/popup/components/Toggle';

describe('Toggle in Chromium', () => {
    let mount: HTMLDivElement;

    afterEach(() => {
        if (mount) {
            render(null, mount);
            mount.remove();
        }
    });

    it('toggles through native Space-key interaction', async () => {
        mount = document.createElement('div');
        document.body.appendChild(mount);
        const onChange = vi.fn();
        render(h(Toggle, { id: 'browser-toggle', label: 'Capture Preview', checked: false, onChange }), mount);

        const checkbox = mount.querySelector('input[type="checkbox"]') as HTMLInputElement;
        checkbox.focus();
        expect(document.activeElement).toBe(checkbox);
        expect(checkbox.checked).toBe(false);

        await userEvent.keyboard('{Space}');

        expect(checkbox.checked).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);
    });
});
