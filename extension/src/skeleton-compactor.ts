const REMOVED_ELEMENTS = 'script,style,noscript,template,iframe,object,embed,meta,link,applet,frame,frameset';
const LANGUAGE_CLASS_PREFIXES = ['language-', 'highlight-source-'];

const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
    a: new Set(['href']),
    img: new Set(['src', 'alt']),
    ol: new Set(['start']),
    th: new Set(['align']),
    td: new Set(['align']),
    'mdz-control': new Set(['data-kind', 'data-type', 'data-state']),
};

const LANGUAGE_ELEMENTS = new Set(['pre', 'code', 'div']);

export function compactSkeleton(root: HTMLElement): void {
    removeDiscardedNodes(root);
    for (const element of [root, ...Array.from(root.querySelectorAll<Element>('*'))]) {
        compactAttributes(element);
    }
}

function removeDiscardedNodes(root: HTMLElement): void {
    root.querySelectorAll(REMOVED_ELEMENTS).forEach((element) => element.remove());

    const comments: Comment[] = [];
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) comments.push(walker.currentNode as Comment);
    comments.forEach((comment) => comment.remove());
}

function compactAttributes(element: Element): void {
    const name = element.localName.toLowerCase();
    const allowed = ALLOWED_ATTRIBUTES[name] ?? new Set<string>();

    for (const attribute of Array.from(element.attributes)) {
        if (attribute.name === 'class' && LANGUAGE_ELEMENTS.has(name)) continue;
        if (!allowed.has(attribute.name)) element.removeAttribute(attribute.name);
    }

    if (LANGUAGE_ELEMENTS.has(name)) compactLanguageClass(element);
}

function compactLanguageClass(element: Element): void {
    const kept = (element.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => LANGUAGE_CLASS_PREFIXES.some((prefix) => token.startsWith(prefix)));

    if (kept.length > 0) element.setAttribute('class', kept.join(' '));
    else element.removeAttribute('class');
}
