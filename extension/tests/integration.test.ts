import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { skeletonize, rehydrate } from '../src/logic';

// Integration test that requires a running backend
// Skipped by default unless INTEGRATION=true is set
const isIntegration = process.env.INTEGRATION === 'true';
const runner = isIntegration ? describe : describe.skip;

runner('Full Stack Integration (Frontend <-> Backend)', () => {
    const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8081/convert";
    const TEST_USER_ID = "integration-test-user-id";

    function setupDOM(htmlString: string) {
        const dom = new JSDOM(htmlString);
        global.document = dom.window.document;
        global.NodeFilter = dom.window.NodeFilter;
        // @ts-expect-error - JSDOM global injection for testing
        global.Node = dom.window.Node;
        return dom.window.document.body;
    }

    it('should convert a complex article end-to-end', async () => {
        // 1. Setup Input HTML (Complex structure with formatting)
        const htmlInput = `
            <article>
                <h1>Integration Test</h1>
                <p>This is a <strong>bold</strong> statement.</p>
                <ul>
                    <li>Item 1</li>
                    <li>Item 2 with <a href="https://example.com">link</a></li>
                </ul>
            </article>
        `;
        const root = setupDOM(htmlInput);
        const article = root.querySelector('article') as HTMLElement;

        // 2. Skeletonize (Frontend)
        const { html, tokens } = skeletonize(article);

        // 3. Send to Backend (Network)
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Origin": "chrome-extension://integration-test",
                "X-User-ID": TEST_USER_ID
            },
            body: JSON.stringify({ 
                html_skeleton: html, 
                url: "https://example.com/test-page" 
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Backend failed: ${response.status} ${err}`);
        }

        const data = await response.json();
        
        // 4. Validate Backend Response Structure
        expect(data).toHaveProperty('markdown_skeleton');

        // 5. Rehydrate (Frontend)
        const finalMarkdown = rehydrate(data.markdown_skeleton, tokens);

        // 6. Assert Final Markdown Quality
        expect(finalMarkdown).toContain('# Integration Test');
        expect(finalMarkdown).toContain('**bold** statement');
    });

    it('should fail with 403 Forbidden when Origin is invalid', async () => {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Origin": "chrome-extension://BAD-ORIGIN",
                "X-User-ID": TEST_USER_ID
            },
            body: JSON.stringify({ html_skeleton: "<div>test</div>" })
        });

        expect(response.status).toBe(403);
        const data = await response.json();
        expect(data.error).toContain("Invalid Extension ID");
    });

    it('should fail with 400 Bad Request for malformed payload', async () => {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Origin": "chrome-extension://integration-test",
                "X-User-ID": TEST_USER_ID
            },
            body: '{ "bad_json": ' 
        });

        expect(response.status).toBe(400);
    });

    it('should fail with 413 Payload Too Large for huge inputs', async () => {
        const hugeHtml = "a".repeat(1.5 * 1024 * 1024);

        const response = await fetch(API_URL, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Origin": "chrome-extension://integration-test",
                "X-User-ID": TEST_USER_ID
            },
            body: JSON.stringify({ html_skeleton: hugeHtml })
        });

        expect(response.status).toBe(413);
    });
});
