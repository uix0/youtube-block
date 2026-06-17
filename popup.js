const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const shortsToggle = document.getElementById("toggle-shorts");
const gamingToggle = document.getElementById("toggle-gaming");

function render() {
  chrome.storage.sync.get(
    { blockedChannels: {}, hideShorts: false, hideGaming: false },
    (data) => {
      shortsToggle.checked = !!data.hideShorts;
      gamingToggle.checked = !!data.hideGaming;

      const channels = data.blockedChannels || {};
      const ids = Object.keys(channels);
      const labelOf = (k) => {
        const e = channels[k] || {};
        return (typeof e === "string" ? e : e.name || e.handle) || k;
      };
      countEl.textContent = ids.length;
      listEl.innerHTML = "";
      emptyEl.hidden = ids.length > 0;

      for (const id of ids.sort((a, b) =>
        labelOf(a).localeCompare(labelOf(b))
      )) {
        const li = document.createElement("li");
        const e = channels[id] || {};

        const name = document.createElement("span");
        name.className = "name";
        name.textContent = labelOf(id);
        name.title = (typeof e === "object" && e.handle) || id;

        const btn = document.createElement("button");
        btn.textContent = "Unblock";
        btn.addEventListener("click", () => {
          delete channels[id];
          chrome.storage.sync.set({ blockedChannels: channels }, render);
        });

        li.appendChild(name);
        li.appendChild(btn);
        listEl.appendChild(li);
      }
    }
  );
}

shortsToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ hideShorts: shortsToggle.checked });
});
gamingToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ hideGaming: gamingToggle.checked });
});

document.getElementById("open-panel").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.url && tab.url.includes("youtube.com")) {
      chrome.tabs.sendMessage(tab.id, { type: "OPEN_CONTROL_PANEL" });
      window.close();
    } else {
      // Open YouTube, then ask the content script to show the panel once ready.
      chrome.tabs.create({ url: "https://www.youtube.com/" }, (newTab) => {
        const listener = (tabId, info) => {
          if (tabId === newTab.id && info.status === "complete") {
            chrome.tabs.sendMessage(newTab.id, { type: "OPEN_CONTROL_PANEL" });
            chrome.tabs.onUpdated.removeListener(listener);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      window.close();
    }
  });
});

document.addEventListener("DOMContentLoaded", render);
