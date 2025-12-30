import { describe, it, expect } from 'vitest';
import { rehydrate } from '../src/logic';

describe('Security & Robustness Rehydration Tests', () => {

    it('should handle Regex Injection in content ($ signs)', () => {
        const tokens = {
            '{{MDZ0}}': 'Price: $100.00',
            '{{MDZ1}}': 'Variable $1 is strict'
        };
        const skeleton = `Item: {{MDZ0}}\nNote: {{MDZ1}}`;
        const result = rehydrate(skeleton, tokens);
        expect(result).toContain('Price: $100.00');
        expect(result).toContain('Variable $1 is strict');
    });

    it('should prevent Token Recursion Attack', () => {
        const tokens = {
            '{{MDZ0}}': 'Start {{MDZ1}} End',
            '{{MDZ1}}': 'Secret'
        };
        const skeleton = `Content: {{MDZ0}}`;
        const result = rehydrate(skeleton, tokens);
        expect(result).toBe('Content: Start {{MDZ1}} End');
        expect(result).not.toContain('Secret');
    });

    it('should handle Link Injection with Pre-Escaped Tokens', () => {
        // NOTE: In the real app, `skeletonize` runs BEFORE the backend, 
        // and it escapes markdown characters. 
        // So a text like "evil](..." becomes "evil\\]\\(...\\\\".
        // The token map passed to `rehydrate` ALREADY contains escaped strings.
        
        const tokens = {
            '{{MDZ0}}': 'evil\\]\\(https://evil.com\\)' // Pre-escaped by skeletonize
        };
        
        // Backend produces: [Link Text]({{MDZ0}})
        // But here we test simple substitution
        const skeletonA = `See {{MDZ0}}`;
        const resultA = rehydrate(skeletonA, tokens);
        
        // Rehydrate should simply put the (escaped) string back.
        expect(resultA).toBe('See evil\\]\\(https://evil.com\\)');
    });

    it('should handle Backslashes with Pre-Escaped Tokens', () => {
        // Input text: C:\Windows\
        // Skeletonize escapes it to: C:\\Windows\\
        const tokens = {
            '{{MDZ0}}': 'C:\\\\Windows\\\\' // This needs to be C:\\Windows\\ in the string literal
        };
        
        const skeleton = `Path: {{MDZ0}}`;
        const result = rehydrate(skeleton, tokens);
        
        expect(result).toBe('Path: C:\\\\Windows\\\\');
    });

    it('should handle adjacent tokens without merging incorrectly', () => {
        const tokens = {
            '{{MDZ0}}': 'Hello',
            '{{MDZ1}}': 'World'
        };
        const skeleton = `{{MDZ0}}{{MDZ1}}`;
        const result = rehydrate(skeleton, tokens);
        expect(result).toBe('HelloWorld');
    });

    it('should rehydrate URL-Encoded tokens from attributes', () => {
        const tokens = {
            '{{MDZ0}}': 'https://example.com/image.png'
        };
        // Backend (html-to-markdown) might encode the token in an href
        // <a href="{{MDZ0}}"> -> [Link](%7B%7BMDZ0%7D%7D)
        const skeleton = `[Link](%7B%7BMDZ0%7D%7D)`;
        
        const result = rehydrate(skeleton, tokens);
        
        expect(result).toBe('[Link](https://example.com/image.png)');
    });
});