# YouTube Channel Blocker

A Chrome extension that lets you block specific channels, and optionally shorts too.

## Features

#### Block a channel by right clicking a video.
  You can right click a video on the home page (also search/sidebar/channel pages), select "block this channel" in the context menu and a small confirmation modal will appear letting you configure the block level & confirm the block.
#### Block levels.
**Feed only**
(default): hidden from the home page, recommendations & the watch page sidebar. Videos will still appears in search.
**Everywhere**
also hidden from search results.
#### Block button on the watch page
There's a button beside the like button that's styled to match YouTubes existing controls. It's the same as the context menu block (right clicking). It's not the context menu here becuase youtube has their own context menu on the watch page.
#### Control panel
There's a control panel that let's you manage your blocks. On the watch page, there's a block button to the left of the "+ Create" button. On the home page, it's on the left side bar at the bottom. In here, you can unblock channels/configure the level of the block
#### Sync
If you have sync enabled in chrome, then the extension will sync settings across signed in chrome browsers.

## Files
- `manifest.json` — extension manifest (MV3).
- `background.js` — service worker; owns the right-click context-menu item.
- `content.js` — runs on YouTube: captures right-clicks, extracts channels, hides
  blocked cards, and injects the watch button, sidebar entry, topbar button, and
  modals.
- `content.css` — styles for hidden cards, the Shorts/Gaming filters, the modals,
  the control panel, and injected buttons.
- `popup.html` / `popup.js` — toolbar popup.
- `options.html` / `options.js` — full control-panel options page.
- `icon16/48/128.png` — toolbar/store icons (`icon.svg` is the source artwork;
  `generate_icons.py` rasterizes it — both are dev-only, not needed at runtime).

## Notes

- Channels are matched by URL handle / channel id when available, and by display
  name as a fallback (the watch-page sidebar exposes no channel link). Two
  different channels sharing an identical display name would be blocked together
  in that fallback case.
- If a channel slips through on some surface, its card element type probably
  isn't in `VIDEO_CONTAINERS` in `content.js` — add its tag there.
- Selectors depend on YouTube's current DOM/class names and may need updating
  when YouTube changes its frontend.
