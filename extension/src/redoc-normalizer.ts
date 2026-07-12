export type AdapterName = 'none' | 'redoc-ce-v2' | 'redocly';

export interface NormalizationSummary {
    adapter: AdapterName;
    normalizedJsonSamples: number;
    normalizedSchemas: number;
    fallbacks: number;
}

interface RendererAdapter {
    readonly name: Exclude<AdapterName, 'none'>;
    matches(root: HTMLElement): boolean;
    findJsonViewers(root: HTMLElement): HTMLElement[];
    findSchemaTables(root: HTMLElement): HTMLTableElement[];
}

interface SchemaField {
    name: string;
    type: string;
    requiredOrNullable: string;
    description: string;
    children: SchemaField[];
}

const MAX_JSON_CHARACTERS = 250_000;
const MAX_JSON_NESTING = 100;

export function normalizeRenderedReDoc(root: HTMLElement): NormalizationSummary {
    const summary: NormalizationSummary = {
        adapter: detectAdapter(root),
        normalizedJsonSamples: 0,
        normalizedSchemas: 0,
        fallbacks: 0,
    };

    if (summary.adapter === 'none') return summary;

    const adapters = [redocCeV2Adapter, redoclyAdapter];
    const matched = adapters.filter((a) => a.matches(root));
    if (matched.length !== 1) return summary;
    const adapter = matched[0];

    for (const viewer of adapter.findJsonViewers(root)) {
        try {
            if (replaceJsonViewer(viewer)) summary.normalizedJsonSamples += 1;
            else summary.fallbacks += 1;
        } catch {
            summary.fallbacks += 1;
        }
    }

    for (const table of adapter.findSchemaTables(root)) {
        try {
            const fields = readSchemaFields(table);
            if (fields && fields.length > 0) {
                const wrapper = buildSchemaDl(fields);
                table.replaceWith(wrapper);
                summary.normalizedSchemas += 1;
            } else {
                summary.fallbacks += 1;
            }
        } catch {
            summary.fallbacks += 1;
        }
    }

    return summary;
}

export function formatJsonLexically(source: string): string | null {
    const compact = source.trim();
    if (compact.length === 0 || compact.length > MAX_JSON_CHARACTERS) return null;
    if (compact.includes('\u2026')) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(compact);
    } catch {
        return null;
    }
    if (parsed === null || (Array.isArray(parsed) === false && typeof parsed !== 'object')) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let result = '';
    const indent = () => '  '.repeat(depth);

    for (const character of compact) {
        if (inString) {
            result += character;
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') { inString = true; result += character; continue; }
        if (/\s/.test(character)) continue;
        if (character === '{' || character === '[') {
            depth += 1;
            if (depth > MAX_JSON_NESTING) return null;
            result += `${character}\n${indent()}`;
        } else if (character === '}' || character === ']') {
            depth -= 1;
            result = result.trimEnd();
            result += `\n${indent()}${character}`;
        } else if (character === ',') {
            result += `,\n${indent()}`;
        } else if (character === ':') {
            result += ': ';
        } else {
            result += character;
        }
    }
    return depth === 0 && inString === false ? result : null;
}

function detectAdapter(root: HTMLElement): AdapterName {
    const adapters = [redocCeV2Adapter, redoclyAdapter];
    const matched = adapters.filter((a) => a.matches(root));
    return matched.length === 1 ? matched[0].name : 'none';
}

function hasOperationSectionId(root: HTMLElement): boolean {
    const sections = root.querySelectorAll('[data-section-id]');
    for (const el of Array.from(sections)) {
        const id = el.getAttribute('data-section-id') || '';
        if (id.includes('operation/') || id.includes('tag/')) return true;
    }
    return false;
}

const redocCeV2Adapter: RendererAdapter = {
    name: 'redoc-ce-v2',
    matches(root: HTMLElement): boolean {
        const hasHost =
            root.querySelector('#redoc') !== null ||
            root.querySelector('redoc') !== null ||
            root.querySelector('[data-section-id]') !== null;
        return hasHost && hasOperationSectionId(root);
    },
    findJsonViewers(root: HTMLElement): HTMLElement[] {
        const results: HTMLElement[] = [];
        const candidates = root.querySelectorAll('.redoc-json');
        for (const el of Array.from(candidates)) {
            if (el.closest('pre')) continue;
            results.push(el as HTMLElement);
        }
        return results;
    },
    findSchemaTables(root: HTMLElement): HTMLTableElement[] {
        const results: HTMLTableElement[] = [];
        const operationSections = root.querySelectorAll('[data-section-id]');
        for (const section of Array.from(operationSections)) {
            const id = section.getAttribute('data-section-id') || '';
            if (!id.includes('operation/')) continue;
            const tables = section.querySelectorAll('table');
            for (const table of Array.from(tables)) {
                if (isSchemaTable(table as HTMLTableElement) && !isInsideSchemaTable(table as HTMLTableElement)) {
                    results.push(table as HTMLTableElement);
                }
            }
        }
        return results;
    },
};

const redoclyAdapter: RendererAdapter = {
    name: 'redocly',
    matches(root: HTMLElement): boolean {
        const hasRoot = root.querySelector('[data-redocly-root="true"]') !== null;
        const hasOperation = root.querySelector('[data-redocly-operation]') !== null;
        return hasRoot && hasOperation;
    },
    findJsonViewers(root: HTMLElement): HTMLElement[] {
        const results: HTMLElement[] = [];
        const candidates = root.querySelectorAll('[data-redocly-json="true"]');
        for (const el of Array.from(candidates)) {
            if (el.querySelector('code')) results.push(el as HTMLElement);
        }
        return results;
    },
    findSchemaTables(): HTMLTableElement[] {
        return [];
    },
};

function replaceJsonViewer(viewer: HTMLElement): boolean {
    const codeEl = viewer.querySelector('code');
    if (!codeEl) return false;

    const clone = codeEl.cloneNode(true) as HTMLElement;

    for (const control of Array.from(clone.querySelectorAll('button, svg'))) {
        control.remove();
    }

    for (const ellipsis of Array.from(clone.querySelectorAll('.ellipsis'))) {
        if (ellipsis.textContent && ellipsis.textContent.trim().length > 0) return false;
        ellipsis.remove();
    }

    const text = clone.textContent || '';
    const formatted = formatJsonLexically(text);
    if (formatted === null) return false;

    while (viewer.firstChild) {
        viewer.removeChild(viewer.firstChild);
    }

    const pre = document.createElement('pre');
    const newCode = document.createElement('code');
    newCode.className = 'language-json';
    newCode.textContent = formatted;
    pre.appendChild(newCode);
    viewer.appendChild(pre);

    return true;
}

function isSchemaTable(table: HTMLTableElement): boolean {
    const rows = Array.from(table.rows);
    return rows.length > 0
        && rows.every((row) => row.cells.length >= 4)
        && rows.some((row) => /^(required|optional|nullable)$/i.test(row.cells[2].textContent?.trim() ?? ''))
        && rows.some((row) => /^(string|number|integer|boolean|object|array)$/i.test(row.cells[1].textContent?.trim() ?? ''));
}

function readSchemaFields(table: HTMLTableElement): SchemaField[] | null {
    const fields: SchemaField[] = [];
    for (const row of Array.from(table.rows)) {
        const [nameCell, typeCell, stateCell, descriptionCell] = Array.from(row.cells);
        const name = nameCell.textContent?.trim() ?? '';
        const type = typeCell.textContent?.trim() ?? '';
        const requiredOrNullable = stateCell.textContent?.trim() ?? '';
        if (!name || !type || !requiredOrNullable) return null;
        const childTable = Array.from(descriptionCell.querySelectorAll('table')).find(isSchemaTable);
        const children = childTable ? readSchemaFields(childTable as HTMLTableElement) : [];
        if (children === null) return null;
        const description = descriptionCell.cloneNode(true) as HTMLElement;
        Array.from(description.querySelectorAll('table')).find(isSchemaTable)?.remove();
        fields.push({ name, type, requiredOrNullable, description: description.textContent?.trim() ?? '', children });
    }
    return fields;
}

function isInsideSchemaTable(table: HTMLTableElement): boolean {
    const parent = table.parentElement;
    if (!parent) return false;
    if (parent.tagName === 'TD') {
        const grandparent = parent.parentElement;
        if (grandparent && grandparent.tagName === 'TR') {
            const greatGrandparent = grandparent.parentElement;
            if (greatGrandparent && (greatGrandparent.tagName === 'TBODY' || greatGrandparent.tagName === 'TABLE')) {
                const ancestorTable = greatGrandparent.tagName === 'TBODY' ? greatGrandparent.parentElement : greatGrandparent;
                if (ancestorTable && ancestorTable.tagName === 'TABLE' && isSchemaTable(ancestorTable as HTMLTableElement)) {
                    return true;
                }
            }
        }
    }
    return false;
}

function buildSchemaDl(fields: SchemaField[]): HTMLElement {
    const wrapper = document.createElement('section');
    wrapper.setAttribute('data-mdz-redoc-schema', 'true');

    const dl = document.createElement('dl');
    for (const field of fields) {
        const dt = document.createElement('dt');
        dt.textContent = field.name;
        dl.appendChild(dt);

        const dd = document.createElement('dd');
        const typeSpan = document.createElement('span');
        typeSpan.textContent = field.type;
        dd.appendChild(typeSpan);

        const stateSpan = document.createElement('span');
        stateSpan.textContent = field.requiredOrNullable;
        dd.appendChild(stateSpan);

        if (field.description) {
            const descSpan = document.createElement('span');
            descSpan.textContent = field.description;
            dd.appendChild(descSpan);
        }

        if (field.children.length > 0) {
            const childDl = buildSchemaDl(field.children);
            dd.appendChild(childDl);
        }

        dl.appendChild(dd);
    }
    wrapper.appendChild(dl);
    return wrapper;
}
