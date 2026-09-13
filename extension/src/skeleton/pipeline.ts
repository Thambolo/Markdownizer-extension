// Skeleton pipeline
//
// A Skeletonizer.process() runs a sequence of transforms over a cloned
// source root, each mutating the clone (and reading the live source root
// where live state is needed, e.g. native control values or computed
// pseudo-element text). This module makes that sequence explicit and
// testable so the transform order is a first-class contract.

export interface SkeletonTransform {
    (root: HTMLElement, clone: HTMLElement): void;
}

export function createSkeletonPipeline(
    transforms: SkeletonTransform[],
): (root: HTMLElement, clone: HTMLElement) => void {
    return (root, clone) => {
        for (const transform of transforms) {
            transform(root, clone);
        }
    };
}