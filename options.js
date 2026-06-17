const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const shortsToggle = document.getElementById("toggle-shorts");
const gamingToggle = document.getElementById("toggle-gaming");

function channelUrl(entry) {
  if (entry.handle) return "https://www.youtube.com" + entry.handle;
  if (entry.name)
    return (
      "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(entry.name)
    );
  return "https://www.youtube.com";
}

function render() {
  chrome.storage.sync.get(
    { blockedChannels: {}, hideShorts: false, hideGaming: false },
    (data) => {
      shortsToggle.checked = !!data.hideShorts;
      gamingToggle.checked = !!data.hideGaming;

      const channels = data.blockedChannels || {};
      const keys = Object.keys(channels);
      const labelOf = (k) => {
        const e = channels[k] || {};
        return (typeof e === "string" ? e : e.name || e.handle) || k;
      };
      countEl.textContent = keys.length;
      listEl.innerHTML = "";
      emptyEl.hidden = keys.length > 0;

      keys
        .sort((a, b) => labelOf(a).localeCompare(labelOf(b)))
        .forEach((key) => {
          const entry =
            typeof channels[key] === "string"
              ? { name: channels[key], handle: null, level: "feed" }
              : channels[key] || {};

          const row = document.createElement("div");
          row.className = "channel-row";

          const link = document.createElement("a");
          link.className = "channel-link";
          link.href = channelUrl(entry);
          link.target = "_blank";
          link.rel = "noopener";
          const nm = document.createElement("span");
          nm.className = "channel-name";
          nm.textContent = entry.name || entry.handle || key;
          const hd = document.createElement("span");
          hd.className = "channel-handle";
          hd.textContent = entry.handle || "";
          link.appendChild(nm);
          link.appendChild(hd);

          const select = document.createElement("select");
          select.innerHTML =
            '<option value="feed">Feed only</option>' +
            '<option value="all">Everywhere</option>';
          select.value = entry.level || "feed";
          select.addEventListener("change", () => {
            channels[key] = {
              handle: entry.handle || null,
              name: entry.name || null,
              level: select.value
            };
            chrome.storage.sync.set({ blockedChannels: channels });
          });

          const remove = document.createElement("button");
          remove.className = "remove";
          remove.textContent = "Remove";
          remove.addEventListener("click", () => {
            delete channels[key];
            chrome.storage.sync.set({ blockedChannels: channels }, render);
          });

          row.appendChild(link);
          row.appendChild(select);
          row.appendChild(remove);
          listEl.appendChild(row);
        });
    }
  );
}

shortsToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ hideShorts: shortsToggle.checked });
});
gamingToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ hideGaming: gamingToggle.checked });
});

// Live-update if storage changes elsewhere (another tab, the in-page panel).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") render();
});

document.addEventListener("DOMContentLoaded", render);
