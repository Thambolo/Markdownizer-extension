# Markdownizer Extension

A privacy-focused Chrome extension that converts any webpage into clean, portable Markdown.

Most "reader mode" extensions process content in the cloud, sending the full page text to a third-party server. Markdownizer is different. It uses a **Client-Heavy Skeletonization** architecture to ensure your content stays private.

## How it Works (Privacy by Design)

Instead of sending the webpage's text to our backend, this extension:
1.  **Scrapes** the DOM locally in your browser.
2.  **Skeletonizes** the content: It replaces all actual text with anonymous tokens (e.g., `{{MDZ0}}`), keeping only the HTML structure.
3.  **Sends** this structure to the backend. The server sees the layout, but **zero** text content.
4.  **Rehydrates** the response: The server returns Markdown with tokens, and the extension swaps the original text back in locally.

## Features

*   **One-click Conversion**: Instantly get Markdown for your notes (Obsidian, Notion, etc.).
*   **Zero Data Leakage**: The backend never sees what you are reading.
*   **Preserves Context**: Maintains headers, lists, and code blocks better than simple regex parsers.

## Development Setup

This project is built with **Vite**, **Preact**, and **Tailwind CSS**.

### Prerequisites
*   Node.js (v20+)
*   npm

### Quick Start

1.  **Install dependencies:**
    ```bash
    cd extension
    npm ci
    ```

2.  **Start the dev server:**
    ```bash
    npm run dev
    ```
    This will watch for file changes and rebuild the extension in `dist/`.

### Loading in Chrome

1.  Open Chrome and navigate to `chrome://extensions`.
2.  Enable **Developer mode** (toggle in the top right).
3.  Click **Load unpacked**.
4.  Select the `extension/dist` folder.

> **Note:** The dev server supports HMR (Hot Module Replacement) for the popup UI, but changes to the `manifest.json` or background scripts usually require reloading the extension in the Chrome dashboard.

## Configuration

By default, the extension points to a local backend.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `VITE_API_URL` | `http://localhost:8080` | The backend API endpoint for processing the skeleton. |

To build for production with a real backend:

```bash
VITE_API_URL=https://api.yourdomain.com npm run build
```

## Permissions Explained

We request the absolute minimum permissions needed to function:

*   `activeTab`: To read the DOM of the *current* page when you click the extension icon. We don't track your history.
*   `scripting`: To inject the extraction logic into the page.
*   `storage`: To save your preferences (e.g., dark mode settings).

## License

MIT
