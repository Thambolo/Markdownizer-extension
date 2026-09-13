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
    findOperationSections(root: HTMLElement): HTMLElement[];
    removeChrome(root: HTMLElement): void;
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

const HTTP_METHODS = 'get|put|post|delete|patch|head|options|trace';
const REDOC_OPERATION_ID = new RegExp(`^tag/[^/]+/paths/.+/(${HTTP_METHODS})$`, 'i');

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

    adapter.removeChrome(root);

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

    for (const operation of adapter.findOperationSections(root)) {
        try {
            normalizeOperationUI(operation);
            normalizeParameterTables(operation);
            removeResponseToolbarControls(operation);
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

// ReDoc CE v2 adapter helpers: find confirmed content region and operation sections

function findReDocContent(root: HTMLElement): HTMLElement | null {
    const host = root.matches('#redoc') ? root : root.querySelector<HTMLElement>('#redoc');
    if (!host) return null;

    const content = host.querySelector<HTMLElement>('.api-content');
    if (!content) return null;

    const hasOperation = Array.from(content.querySelectorAll<HTMLElement>('[data-section-id]')).some((section) =>
        REDOC_OPERATION_ID.test(section.dataset.sectionId ?? ''),
    );
    return hasOperation ? content : null;
}

function isOperationSection(el: HTMLElement): boolean {
    return REDOC_OPERATION_ID.test(el.dataset.sectionId ?? '');
}

const redocCeV2Adapter: RendererAdapter = {
    name: 'redoc-ce-v2',
    matches(root) {
        return findReDocContent(root) !== null;
    },
    findJsonViewers(root) {
        const content = findReDocContent(root);
        return content
            ? Array.from(content.querySelectorAll<HTMLElement>('.redoc-json')).filter((viewer) => !viewer.closest('pre'))
            : [];
    },
    findSchemaTables(root) {
        const content = findReDocContent(root);
        if (!content) return [];
        return Array.from(content.querySelectorAll<HTMLElement>('[data-section-id]'))
            .filter((section) => isOperationSection(section))
            .flatMap((section) => Array.from(section.querySelectorAll<HTMLTableElement>('table')))
            .filter((table) => isSchemaTable(table) && !isInsideSchemaTable(table));
    },
    findOperationSections(root) {
        const content = findReDocContent(root);
        if (!content) return [];
        return Array.from(content.querySelectorAll<HTMLElement>('[data-section-id]'))
            .filter((section) => isOperationSection(section));
    },
    removeChrome(root) {
        const host = root.matches('#redoc') ? root : root.querySelector<HTMLElement>('#redoc');
        host?.querySelectorAll('.menu-content').forEach((element) => element.remove());
    },
};

// Redocly adapter: matches pages using Redocly-specific host and operation markers

const redoclyAdapter: RendererAdapter = {
    name: 'redocly',
    matches(root) {
        const hasRoot = root.querySelector('[data-redocly-root="true"]') !== null;
        const hasOperation = root.querySelector('[data-redocly-operation]') !== null;
        return hasRoot && hasOperation;
    },
    findJsonViewers(root) {
        const results: HTMLElement[] = [];
        const candidates = root.querySelectorAll('[data-redocly-json="true"]');
        for (const el of Array.from(candidates)) {
            if (el.querySelector('code')) results.push(el as HTMLElement);
        }
        return results;
    },
    findSchemaTables() {
        return [];
    },
    findOperationSections() {
        return [];
    },
    removeChrome() {},
};

// Select the single matching adapter, or return none if ambiguous

function detectAdapter(root: HTMLElement): AdapterName {
    const adapters = [redocCeV2Adapter, redoclyAdapter];
    const matched = adapters.filter((a) => a.matches(root));
    return matched.length === 1 ? matched[0].name : 'none';
}

// Replace a ReDoc visual JSON tree with a semantic fenced code block

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

// Detect and rewrite four-column schema tables into nested definition lists

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

// Rewrite operation method/path/server UI into labeled semantic HTML,
// add explicit headers to parameter tables, and remove response toolbar buttons

function normalizeOperationUI(operation: HTMLElement): boolean {
    const method = operation.querySelector<HTMLElement>('button > span.http-verb[type]');
    const path = method?.nextElementSibling;
    const source = method?.closest('div');
    const server = source?.querySelector<HTMLElement>(':scope > div[aria-hidden="true"] [role="button"]');
    const methodText = method?.textContent?.trim();
    const pathText = path?.textContent?.trim();
    const serverText = server?.textContent?.trim();
    if (!source || !methodText || !pathText || !pathText.startsWith('/') || !serverText || !serverText.startsWith('http')) return false;

    const replacement = document.createElement('section');
    replacement.setAttribute('data-mdz-redoc-operation', 'true');
    const heading = document.createElement('p');
    heading.textContent = `${methodText.toUpperCase()} ${pathText}`;
    const link = document.createElement('a');
    link.href = serverText;
    link.textContent = serverText;
    replacement.append(heading, link);
    source.replaceWith(replacement);
    return true;
}

function normalizeParameterTables(operation: HTMLElement): void {
    for (const table of Array.from(operation.querySelectorAll<HTMLTableElement>('table'))) {
        normalizeParameterTable(table);
    }
}

function normalizeParameterTable(table: HTMLTableElement): boolean {
    const prevSibling = table.previousElementSibling;
    if (!prevSibling || prevSibling.tagName !== 'H5') return false;
    const label = prevSibling.textContent?.replace(/\s+/g, ' ').trim();
    if (label !== 'query Parameters') return false;
    const rows = Array.from(table.rows);
    if (rows.length === 0 || !rows.every((row) => row.cells.length === 2 && row.cells[0].getAttribute('kind') === 'field')) return false;

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const headerLabel of ['Parameter', 'Type']) {
        const cell = document.createElement('th');
        cell.textContent = headerLabel;
        headerRow.appendChild(cell);
    }
    thead.appendChild(headerRow);
    table.insertBefore(thead, table.firstChild);
    table.setAttribute('data-mdz-redoc-parameters', 'true');
    return true;
}

function removeResponseToolbarControls(operation: HTMLElement): void {
    operation.querySelectorAll<HTMLElement>('[data-tabs="true"] [role="tabpanel"] button').forEach((button) => {
        if (/^(Copy|Expand all|Collapse all)$/i.test(button.textContent?.trim() ?? '')) button.remove();
    });
}
