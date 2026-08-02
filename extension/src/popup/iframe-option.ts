export type IframePreference = 'auto' | 'include' | 'exclude';

export interface IframeOptionState {
    eligible: boolean;
    preference: IframePreference;
}

export function initialIframeOptionState(): IframeOptionState {
    return { eligible: false, preference: 'auto' };
}

export function applyIframeEligibility(
    state: IframeOptionState,
    eligible: boolean,
): IframeOptionState {
    return { eligible, preference: state.preference };
}

export function setIframePreference(
    state: IframeOptionState,
    preference: Exclude<IframePreference, 'auto'>,
): IframeOptionState {
    return { eligible: state.eligible, preference };
}

export function isIframeIncluded(state: IframeOptionState): boolean {
    return state.eligible && state.preference !== 'exclude';
}
