# RitPost – Group Posting for WhatsApp Web & Facebook

A Chrome extension for WhatsApp Web. Write a message once, pick your groups from a saved list, and RitPost goes through them one by one. It opens each group and fills in the message. You press **Enter**, and the next group opens on its own.

It can also post the same message to your **Facebook groups and Pages**; see [Facebook groups and Pages](#facebook-groups-and-pages).

In **Manual** mode (the default) RitPost never presses Send. You send every message yourself. An optional **Automatic** mode can send after a countdown; see [Send modes](#send-modes).

## Install

Download `ritpost-<version>.zip` from the [latest release](https://github.com/SirrJay/ritpost-whatsapp/releases/latest) and unzip it, or clone this repository. Then load it in developer mode:

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this project folder.
4. Pin the extension from the puzzle-piece menu so it's easy to reach.

When you update, click the reload icon on the RitPost card. Already-open WhatsApp Web tabs pick up the new version on their own; if anything looks off, refresh the tab.

## Use it

1. Click the RitPost icon (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>). RitPost opens as a **side panel docked beside WhatsApp Web** and opens or switches to WhatsApp Web for you. Inside WhatsApp Web there is also a **RitPost** button in the bottom-left corner that opens the panel.
2. Sign in to WhatsApp Web if needed, then open the **Groups** tab:
   - **Import groups from WhatsApp Web** reads your chat list and shows **only groups** by default. Individual contacts sit under a separate tab. If any contacts were saved before, RitPost offers to remove them.
   - Or type a group name by hand and click **Add**.
   - Tick groups to act on several at once: **Add to list**, **Send to**, or **Delete** (or press <kbd>Del</kbd>). Every delete can be undone from the message that appears.
3. In the **Compose** tab, write your message. Type `{group}` anywhere to insert each group's name.
   To send photos, videos or documents too, click **Attach photos, videos or files**, or drag files onto the message area.
4. Tick the groups to send to and click **Start sending**.
5. A RitPost panel appears in WhatsApp Web. For each group:
   - the chat opens and your message is filled in
   - you check it and press **Enter**
   - RitPost sees the message was sent and opens the next group after a short pause

The panel has these controls:

| Button | What it does |
| --- | --- |
| **Skip** | Leave this group out and move on |
| **Pause / Resume** | Hold before opening the next group |
| **Stop** | End the session |
| **Reopen** | Go back to the current group if you clicked away to another chat |
| **Refill** | Put the message back if you cleared the box |
| **Mark sent** | Count this group as sent if you sent it some other way |

At the end you get a summary that lists which groups were sent, skipped or not found.

The side panel stays open while you send. It shows live progress and has its own **Pause** and **Stop** buttons.

## Send modes

Choose the mode in the switch above the Start button.

- **Manual** (default): RitPost opens each group and fills in the message. You press **Enter** to send, and the next group opens.
- **Automatic**: RitPost opens each group, fills in the message, shows a **countdown** (6 s by default, adjustable from 5 to 600 s), then presses **Send** itself and moves on.
  - During the countdown you can click **Send now**, **Hold** (send this one yourself), **Skip**, **Pause** or **Stop**.
  - Before pressing Send, RitPost checks again that the right group is still open and the message is complete. If you switch chats, it pauses rather than sending to the wrong one.
  - **Vary the interval slightly** (Settings, on by default) makes each countdown a little different.
  - You can switch between Manual and Automatic during a session from the panel inside WhatsApp Web.

> **Important:** WhatsApp's terms don't allow automated or bulk messaging. No interval makes automatic sending compliant, and any interval can lead to your account being restricted or banned. Longer intervals, smaller batches and posting only to groups that expect your messages lower the risk. Manual mode is the safe choice.

## Attachments

- Attach up to 10 files, each up to 16 MB (64 MB in total): photos, videos or documents.
- For each group, RitPost hands the files to WhatsApp, which opens its attachment preview. Your message goes in as the **caption**, with `{group}` filled in.
- **Manual mode**: check the preview and press **Enter** (or click Send).
- **Automatic mode**: RitPost clicks Send in the preview after the countdown. If the caption couldn't be added, it holds and lets you send that group yourself.
- Attachments stay in the panel until you remove them, so you can reuse them for the next post. Each file has **Replace** (pick another file; it takes the same place) and **Remove**, and **Remove all** clears them at once. Each of these can be undone from the message that appears. They're stored only in your browser, and aren't included in backups.
- If the preview doesn't open in a chat, click **Retry**. WhatsApp sometimes changes how it accepts files.

## Facebook groups and Pages

RitPost can post the same message to your Facebook groups and the Facebook Pages you manage.

1. Open the **Facebook** tab in the side panel. Groups and Pages have separate lists: switch with **Groups | Pages**.
2. Add where to post:
   - **Import my Facebook groups** reads the groups you've joined (Facebook's "Your groups" page).
   - **Import Pages I manage** (on the Pages list) reads your Pages (Facebook's "Your Pages" page).
   - Or paste a group or Page link and click **Add**.
3. Tick groups and Pages, choose **Manual** or **Automatic**, then click **Post to …** (for example "Post to 3 groups + 1 Page"). The message and photos/videos come from the **Compose** tab.
4. For each one, RitPost opens it, opens the post box ("Write something…" / "What's on your mind?"), fills in your message and attaches your photos and videos. If Facebook ignores RitPost's click on the post box, the panel asks you to click it once and RitPost carries on by itself.
5. A panel in the corner of Facebook shows progress, with **Skip** and **Stop**.

### Manual and Automatic

- **Manual** (default): you check each post and click **Post**. RitPost then waits at least 30 seconds (60 by default) before the next one.
- **Automatic**: RitPost gives you a review countdown (10 seconds by default) with **Continue now**, **Hold**, **Skip** and **Stop**, then switches profile if needed, fills in the post and clicks **Next** by itself. **You click Post** to publish each one (Facebook only accepts your own click there); RitPost highlights the button, shows "Click Post" in the tab title, records your click and carries on with the next one. To keep the risk low:
  - it waits at least **2 minutes** between posts (**5 minutes** by default), and makes each wait randomly up to 30% longer;
  - it stops at a **daily limit** (20 posts by default, up to 50);
  - it **stops at once** if Facebook shows a "temporarily blocked", "going too fast" or similar limit message.


Facebook's terms don't allow automated posting, and no interval is guaranteed to be safe; a long interval and a low daily limit only lower the risk. Post only where your post is welcome.

### Pages

Pages are posted after groups, and RitPost switches profiles by itself, in both Manual and Automatic mode:

- When it's a Page's turn, RitPost switches to that Page's profile so the post comes from the Page. It clicks the Page's **Switch Now** button if Facebook shows one, otherwise your profile picture (top right) → **Switch to <Page>** (opening **See all profiles** when the Page isn't listed). Names must match exactly, so "Sirr John" and "Sirr John - Believe & Build Podcast" are never confused.
- If you're already using Facebook as that Page, RitPost doesn't switch; it scrolls down to the post box. If you're using Facebook as another Page, it switches through your profile menu.
- If a switch method doesn't work, the next attempt uses a different one (Switch Now → profile menu → other switch buttons).
- RitPost remembers which profile is your own, so it can switch back reliably. If it can't tell (for example a Page you never imported), it reads Facebook's "Your Pages" list once to find out.
- Page posts use Facebook's two steps (**Next**, then **Post** on "Post settings"); in Manual mode your Post click on the second step is recognised.
- It never posts in the visitor box ("Write something to <Page>…"), which would post as you.
- If a group comes after a Page, RitPost switches back to your own profile first.
- At the end, the Facebook panel offers **Switch back to my profile**.

If switching fails twice, RitPost asks you to switch yourself and click **Try again**.

### Good to know

- **Link previews.** Facebook shows a link preview only on posts without photos or videos; it drops the preview as soon as one is added. When your message has a link and you have photos/videos attached, RitPost asks when you start: **Show the link preview** (posts the text and link, leaves the photos/videos out on Facebook) or **Post the photos/videos** (the link stays as plain text). It remembers your choice. Before the countdown carries on, RitPost waits for Facebook to build the preview, and removes an old preview left in a draft.
- WhatsApp formatting marks (`*bold*`, `_italic_`, `~strike~`) are removed, because Facebook doesn't use them. `{group}` works the same as on WhatsApp.
- Facebook gets photos and videos only; documents are sent to WhatsApp only.
- If you close the post box without posting, RitPost doesn't count it and offers **Fill again**.
- **Select unposted** (under the list after a session) picks everything that wasn't posted, for example to continue the next day.

## Premium features

- **Templates**: save messages you send often and load them in one click (Compose → Templates).
- **Group lists**: save a selection, such as "Church groups", and reselect it with one chip. Add more groups to an existing list at any time (saving under an existing name adds to that list and never removes anything). In the Groups tab you can rename a list, tick or untick its groups, and delete lists one at a time or several at once. Deleting a list keeps its groups.
- **Formatting toolbar and live preview**: bold, italic, strikethrough and monospace, shown the way WhatsApp will display them.
- **Smart group finding**: emoji names are handled. If the group isn't on screen, RitPost searches WhatsApp using the name without emojis. If that fails too, it scrolls through your whole chat list.
- **Failure reasons and recovery**: groups that failed are marked. You can rename them in place, then use **Select unsent** or **Retry unsent** to send to the rest.
- **Draggable, collapsible progress panel** with an "Up next" preview.
- **Shortcuts**: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> opens RitPost, <kbd>Ctrl</kbd>+<kbd>Enter</kbd> starts sending, and <kbd>Ctrl</kbd>+<kbd>B</kbd> / <kbd>Ctrl</kbd>+<kbd>I</kbd> format text.

## Settings

- **Automatic sending interval**: in Automatic mode, the countdown on each group before RitPost presses Send (default 6 s, 5 to 600 s).
- **Vary the interval slightly**: makes each countdown a little different (−15% to +25%).
- **Pause between groups (manual)**: how long to wait after a send before opening the next group (default 2 s).
- **Backup**: export or import your groups, lists and templates as JSON.
- **Reset**: delete all saved data.

## Privacy

Full policy: https://sirrjay.github.io/ritpost-whatsapp/store/privacy-policy.html


Everything stays on your computer in `chrome.storage.local`. RitPost has no servers, no analytics, and doesn't talk to anything outside your browser. It only runs on `web.whatsapp.com`.

## Troubleshooting

- **"Group not found"**: the saved name doesn't exactly match the chat title in WhatsApp. Re-import the group, or fix the spelling. Archived chats only show up after you unarchive them.
- **Panel doesn't appear after updating the extension**: reload the WhatsApp Web tab.
- **The message didn't fill in**: click **Retry** or **Refill**. WhatsApp Web changes its page layout from time to time, and some selectors in `content/content.js` may need updating when it does.

## Project layout

```
manifest.json            Manifest V3 config
background.js            Side panel, finds or opens the WhatsApp/Facebook tab, relays commands, saves backups
content/content.js       Opens chats, fills messages, notices sends, shows the progress panel
content/page-bridge.js   Tells groups apart from contacts when importing
content/facebook.js      Facebook: opens each group/Page, fills the post box, waits for you to click Post
popup/                   Compose, group manager and settings UI (shown in the side panel)
icons/                   Extension icons
store/                   Chrome Web Store listing text, privacy policy and promo images
```
