# Markdownizer: The Privacy-First Web Clipper

Convert any webpage into clean, structured Markdown. Locally and privately.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)]()

Markdownizer is a browser extension designed for developers and knowledge workers who need to convert web content into high-quality Markdown while maintaining total privacy. It is optimized for Personal Knowledge Management (PKM) systems like Obsidian and for providing clean, semantic context to Large Language Models (LLMs).

## Core Philosophy: Privacy by Design

Most web clippers process content on third-party servers, exposing your reading history and private data. Markdownizer uses a **Client-Heavy Skeletonization** architecture to ensure your data stays on your machine.

1.  **Local Skeletonization**: The extension extracts the HTML structure locally and replaces all text content with anonymous tokens (e.g., `{{MDZ0}}`).
2.  **Structural Conversion**: Only the structural "skeleton" (tags and layout) is sent to the API. The server sees the shape of the data but zero readable content.
3.  **Local Rehydration**: The processed Markdown structure is returned, and the extension injects your original text back into the document locally.

## Features

*   **One-Click Conversion**: Transform the active tab into Markdown instantly.
*   **LLM Optimization**: Reduces token counts by 30-50% compared to raw HTML while preserving semantic hierarchy and logic.
*   **Smart Extraction**: Prioritizes main content and handles complex code blocks using an integrated `readability.js` engine.
*   **Developer Friendly**: Automatically detects syntax highlighting languages and preserves nested list indentation.

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

1.  Navigate to the webpage you wish to convert.
2.  Click the **Markdownizer** icon in your browser toolbar.
3.  Wait for the analysis to complete.
4.  Use the **Copy** or **Download** buttons to retrieve your Markdown.

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

## Permissions Explained

Markdownizer follows the Principle of Least Privilege:
*   `activeTab`: Required to capture the structure of the currently focused page.
*   `scripting`: Required to execute the extraction engine within the page context.
*   `storage`: Required to persist user preferences (e.g., auto-download settings).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
