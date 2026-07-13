# Markdownizer Extension

Turn any webpage into clean Markdown for your preferred LLM.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)]()

Markdownizer is a browser extension for people who want to turn the current page into clean Markdown and feed it into their preferred LLM. The clearest use case is grabbing an assignment brief, documentation page, article, or research page and turning it into context that is easier to paste into ChatGPT, Claude, Gemini, or another LLM.

## Core Philosophy: Privacy by Design

Most web clippers process readable content on third-party servers. Markdownizer uses a **Client-Heavy Skeletonization** architecture so readable page text is tokenized locally before conversion.

1.  **Local Skeletonization**: The extension extracts the HTML structure locally and replaces all text content with anonymous tokens (e.g., `{{MDZ0}}`).
2.  **Structural Conversion**: The extension sends a structural skeleton to the API for conversion. The backend receives structure and metadata needed for conversion, but not the readable page text body.
3.  **Local Rehydration**: The processed Markdown structure is returned, and the extension injects your original text back into the document locally.

## Features

*   **One-Click Conversion**: Transform the active tab into Markdown instantly.
*   **LLM-Ready Output**: Produces cleaner context than raw HTML, messy copy-paste, or sending only the URL.
*   **Smart Extraction**: Prioritizes main content and handles complex code blocks using an integrated `readability.js` engine.
*   **Structure Preservation**: Keeps useful headings, lists, tables, and code blocks readable.

## Installation

### Browser Stores
*   **Chrome Web Store**: (Coming Soon)
*   **Firefox Add-ons**: (Coming Soon)

### Manual Installation (Developer Mode)

1.  Clone the repository:
    ```bash
    git clone https://github.com/Thambolo/Markdownizer-extension.git
    ```
2.  Build the project (see [Development Setup](#development-setup)).
3.  Open Chrome and navigate to `chrome://extensions`.
4.  Enable **Developer mode** in the top right.
5.  Click **Load unpacked** and select the `extension/dist` folder.

## Usage

1.  Navigate to the webpage you want to convert.
2.  Click the **Markdownizer** icon in your browser toolbar.
3.  Wait for the analysis to complete.
4.  Use the **Copy** or **Download** buttons to retrieve your Markdown.
5.  Paste the result into your preferred LLM.

## Development Setup

Built with **Vite**, **Preact**, **TypeScript**, and **Tailwind CSS**.

### Prerequisites
*   Node.js (v20+)
*   npm

### Quick Start
```bash
cd extension
npm ci
npm run dev
```
The extension will be built into the `dist/` directory and will watch for source changes.

### Configuration
To build the extension for a specific API endpoint:
```bash
VITE_API_URL=https://api.yourdomain.com npm run build
```

For a stable extension ID while loading an unpacked **development** build, set
`DEV_EXTENSION_KEY` in a local `.env` file. The key is intentionally ignored
for production builds and Chrome Web Store uploads. Generate it from the
`key` field of a development extension manifest; do not commit the key.

### Tests

```bash
npm test -- --run
npm run test:browser
```

Browser tests run Chromium headlessly through Playwright.

## Permissions Explained

Markdownizer follows the Principle of Least Privilege:
*   `activeTab`: Required to capture the structure of the currently focused page.
*   `scripting`: Required to execute the extraction engine within the page context.
*   `storage`: Required to persist user preferences (e.g., auto-download settings).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
