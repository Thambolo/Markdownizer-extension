import { defineManifest } from '@crxjs/vite-plugin';
import packageJson from './package.json';

// Convert VITE_API_URL to a match pattern
// e.g. "https://api.example.com/v1" -> "https://api.example.com/*"
const getApiMatchPattern = () => {
  const url = process.env.VITE_API_URL || 'http://localhost:8080/convert';
  try {
    const origin = new URL(url).origin;
    return `${origin}/*`;
  } catch (e) {
    console.warn('Invalid VITE_API_URL, defaulting to localhost');
    return 'http://localhost:8080/*';
  }
};

const { version, name, description } = packageJson;

// Convert from SemVer (e.g. 0.1.0-beta.1) to Chrome version (e.g. 0.1.0.1)
const [major, minor, patch, label = '0'] = version
  // can only contain digits, dots, or dash
  .replace(/[^\d.-]+/g, '')
  // split into version parts
  .split(/[.-]/);

export default defineManifest(async (env) => ({
  manifest_version: 3,
  name: env.mode === 'development' ? `[DEV] Markdownizer` : "Markdownizer",
  description,
  // up to four numbers separated by dots
  version: `${major}.${minor}.${patch}.${label}`,
  // semver is OK in "version_name"
  version_name: version,
  permissions: [
    "activeTab",
    "scripting",
    "storage"
  ],
  host_permissions: [
    getApiMatchPattern()
  ],
  action: {
    default_popup: "index.html",
    default_icon: {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  background: {
    service_worker: "src/background.ts",
    type: "module"
  },
  content_scripts: [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content.ts"]
    }
  ],
  icons: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}));
