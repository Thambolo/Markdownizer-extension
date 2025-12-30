import { useState, useEffect } from 'preact/hooks';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { StatusOrb } from './components/StatusOrb';
import { StatusMessage } from './components/StatusMessage';
import { ActionButtons } from './components/ActionButtons';

interface ExtensionResponse {
  success: boolean;
  markdown: string;
  error?: string;
}

export function App() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [markdown, setMarkdown] = useState('');
  const [filename, setFilename] = useState('converted');
  const [error, setError] = useState('');
  const [autoDownload, setAutoDownload] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(['autoDownload'], (result) => {
      if (result.autoDownload !== undefined) {
        setAutoDownload(result.autoDownload);
      }
    });
  }, []);

  const sanitizeTitle = (title?: string) => {
    return (title || "markdown-page")
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase();
  };

  const toggleAutoDownload = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const newValue = target.checked;
    setAutoDownload(newValue);
    chrome.storage.local.set({ autoDownload: newValue });
  };

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2000);
  };

  const handleConvert = async () => {
    if (status === 'loading') return;
    setStatus('loading');
    setError('');
    setMarkdown('');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) throw new Error("No active tab found");

      const response = await ensureContentScriptLoaded(tab.id);
      processResponse(response, tab);

    } catch (err: unknown) {
      console.error(err);
      const errorMessage = err instanceof Error ? err.message : "Failed. Refresh the tab.";
      setError(errorMessage);
      setStatus('error');
    }
  };

  const processResponse = (response: ExtensionResponse, tab: chrome.tabs.Tab) => {
      if (response && response.success) {
        const safeTitle = sanitizeTitle(tab.title);
        setMarkdown(response.markdown);
        setFilename(safeTitle);
        setStatus('success');

        if (autoDownload) {
          downloadFile(response.markdown, safeTitle);
        }
      } else {
        throw new Error(response.error || "Unknown error occurred");
      }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const openSettings = () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  };

    return (
      <div class="w-[320px] min-h-[400px] flex flex-col bg-slate-950 text-slate-100 font-['Inter'] selection:bg-indigo-500/30">
        
        <Header openSettings={openSettings} />

        {/* Main Content */}
        <main class="flex-1 flex flex-col p-6 items-center justify-center gap-6 relative">

            <StatusOrb status={status} handleConvert={handleConvert} />
        
            <StatusMessage status={status} markdownLength={markdown.length} error={error} />

            {/* Success Actions (Only visible on Success) */}
            {status === 'success' && (
                <ActionButtons 
                    copied={copied} 
                    downloaded={downloaded}
                    handleCopy={handleCopy} 
                    handleDownload={() => downloadFile(markdown, filename)} 
                />
            )}

        </main>

        <Footer autoDownload={autoDownload} toggleAutoDownload={toggleAutoDownload} />

      </div>
    );
}

/**
 * Ensures the content script is loaded before sending a message.
 * If the initial message fails, it attempts to inject the script and retry.
 */
async function ensureContentScriptLoaded(tabId: number): Promise<ExtensionResponse> {
    try {
        return await chrome.tabs.sendMessage(tabId, { action: "convert_page" });
    } catch (e: unknown) {
        // If messaging fails, the script might not be injected (e.g. extension updated or fresh tab)
        const manifest = chrome.runtime.getManifest();
        const contentScriptFile = manifest.content_scripts?.[0]?.js?.[0];

        if (!contentScriptFile) {
            throw new Error("Content script configuration missing in manifest");
        }

        await chrome.scripting.executeScript({
            target: { tabId },
            files: [contentScriptFile]
        });

        // Retry loop: The script might take a moment to initialize its message listeners
        let lastError;
        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            try {
                return await chrome.tabs.sendMessage(tabId, { action: "convert_page" });
            } catch (err) {
                lastError = err;
            }
        }
        
        throw lastError || new Error("Failed to establish connection to content script");
    }
}
