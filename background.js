// Service worker: owns the context menu and relays block actions to the page.

const MENU_ID = "yt-block-channel";

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: "Block this channel",
        contexts: ["all"],
        documentUrlPatterns: ["*://*.youtube.com/*"]
      },
      () => {
        // Swallow the harmless "duplicate id" error if two inits race.
        void chrome.runtime.lastError;
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);
// Also run when the service worker spins up, in case neither event fired.
createMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  // The content script remembers which video was last right-clicked.
  chrome.tabs.sendMessage(tab.id, { type: "BLOCK_LAST_RIGHT_CLICKED" }, () => {
    // Swallow "no receiver" errors (e.g. tab not yet loaded).
    void chrome.runtime.lastError;
  });
});
