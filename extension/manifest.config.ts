import { defineManifest } from '@crxjs/vite-plugin';
import { loadEnv } from 'vite';
import packageJson from './package.json';

// Convert VITE_API_URL to a match pattern
// e.g. "https://api.example.com/v1" -> "https://api.example.com/*"
const getApiMatchPattern = (env: Record<string, string>) => {
  const url = env.VITE_API_URL || 'http://localhost:8080/convert';
  try {
    const origin = new URL(url).origin;
    return `${origin}/*`;
  } catch (e) {
    console.warn('Invalid VITE_API_URL, defaulting to localhost');
    return 'http://localhost:8080/*';
  }
};

const getDevExtensionKey = (env: Record<string, string>) => {
  const key = env.DEV_EXTENSION_KEY?.trim();
  return key ? { key } : {};
};

const { version } = packageJson;

// Convert from SemVer (e.g. 0.1.0-beta.1) to Chrome version (e.g. 0.1.0.1)
const [major, minor, patch, label = '0'] = version
  // can only contain digits, dots, or dash
  .replace(/[^\d.-]+/g, '')
  // split into version parts
  .split(/[.-]/);

export default defineManifest(async (env) => {
  // Load env file based on `mode` in the current working directory.
  // The third parameter '' is used to load all variables regardless of prefix.
  const loadedEnv = loadEnv(env.mode, process.cwd(), '');

  return {
    manifest_version: 3,
    // Localized via _locales/<locale>/messages.json (default_locale: en).
    // Chrome resolves __MSG_*__ placeholders at runtime; the Chrome Web Store
    // uses the resolved values for the listing title and summary. Development
    // builds keep an explicit [DEV] prefix to distinguish them from
    // production/unpacked installs.
    name: env.mode === 'development' ? '[DEV] Markdownizer' : "__MSG_extensionName__",
    ...(env.mode === 'development' ? getDevExtensionKey(loadedEnv) : {}),
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    // up to four numbers separated by dots
    version: `${major}.${minor}.${patch}.${label}`,
    // semver is OK in "version_name"
    version_name: version,
    permissions: [
      "activeTab",
      "scripting",
      "storage",
      "downloads",
      "offscreen"
    ],
    host_permissions: [
      getApiMatchPattern(loadedEnv)
    ],
    optional_host_permissions: [
      "<all_urls>"
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
    icons: {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  };
});
