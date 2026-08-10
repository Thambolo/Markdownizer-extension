# Markdownizer Extension

Turn any webpage into clean Markdown for your preferred LLM.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.3.0-blue.svg)]()

Markdownizer turns the current page into clean, structured Markdown — docs, articles, and assignment briefs become high-quality context for ChatGPT, Claude, Gemini, or any LLM in one click.

Landing page: [markdownizer.thambolo.com](https://markdownizer.thambolo.com/)

## Privacy by Design

Readable page text never leaves your browser:

1. **Local skeletonization** — text is replaced with anonymous tokens before anything is sent.
2. **Structural conversion** — only the page's structure is sent to the server for Markdown conversion.
3. **Local rehydration** — your text is restored locally.

## Features

*   **One-Click Conversion**: Transform the active tab into Markdown instantly.
*   **LLM-Ready Output**: Cleaner context than raw HTML, messy copy-paste, or a bare URL.
*   **Smart Extraction**: Prioritizes main content and handles complex code blocks with an integrated readability engine.
*   **Structure Preservation**: Headings, lists, tables, and code blocks stay readable.
*   **Capture Preview**: Highlights what will be captured, so you can verify before converting.
*   **Capture Full Page**: Converts the entire page when Smart selection is too narrow.
*   **Download Images (ZIP Bundle)**: One click converts the page and downloads it with its images as a ZIP — built locally with live progress, so the download finishes even if you close the popup.

## Installation

### Browser Stores
*   **Chrome Web Store**: [Install Markdownizer](https://chromewebstore.google.com/detail/mmnhipdmonlffimgilnemjmkfmdllfga?utm_source=github)
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

## Permissions Explained

Markdownizer follows the Principle of Least Privilege:
*   `activeTab`: Capture the structure of the current page.
*   `scripting`: Run the extraction engine in the page.
*   `storage`: Persist your preferences.
*   `downloads`: Save the `.md` and ZIP downloads.
*   `offscreen`: Assemble ZIP bundles in the background.
*   `all_urls` (optional): Requested once, only when you enable Download images, to fetch the page's images.

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

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
