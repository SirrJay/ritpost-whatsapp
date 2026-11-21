# RitPost – Post to WhatsApp, Facebook, Instagram & X

A Chrome extension for WhatsApp Web. Write a message once, pick your groups from a saved list, and RitPost goes through them one by one. It opens each group and fills in the message. You press **Enter**, and the next group opens on its own.

It can also post the same message to your **Facebook groups and Pages** ([Facebook groups and Pages](#facebook-groups-and-pages)) and to **Instagram and X** ([Instagram and X](#instagram-and-x)), edit your photos first in **RitPost Studio** ([RitPost Studio](#ritpost-studio-photo-editor)), add **emojis** anywhere you write, and **schedule** all of it.

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
- **Link previews.** WhatsApp never shows a link preview on a caption. So when your message has a link, RitPost (by default) sends the files first without a caption, then your message as its own text, with its link preview. Untick **Send my message separately after the files** under the attachments to use the caption instead. For any message with a link, RitPost waits until WhatsApp has loaded the preview before it sends (and in Manual mode before it tells you it's ready).
- **Manual mode**: check the preview and press **Enter** (or click Send).
- **Automatic mode**: RitPost clicks Send in the preview after the countdown. If the caption couldn't be added, it holds and lets you send that group yourself.
- Attachments stay in the panel until you remove them, so you can reuse them for the next post. Each file has **Replace** (pick another file; it takes the same place) and **Remove**, and **Remove all** clears them at once. Each of these can be undone from the message that appears. They're stored only in your browser, and aren't included in backups.
- If the preview doesn't open in a chat, click **Retry**. WhatsApp sometimes changes how it accepts files.

## Facebook groups and Pages

RitPost can post to your Facebook groups and the Facebook Pages you manage, with your Compose message or a Facebook post of its own.

**Facebook post box.** At the top of the Facebook tab, the post follows your Compose message (without WhatsApp marks). Untick **Same as Compose**, or just start typing, to write a separate Facebook post. The toolbar has 😊 emoji, **✨ AI** (write or rewrite the post for Facebook, with the same options as Compose), **# Hashtags** (your saved hashtag sets, shared with Instagram and X), **+ Name** (inserts `{group}`, replaced by each group's or Page's name) and **Preview** (shows the post as the first selected group will get it). Tick **Same as Compose** again to follow Compose. *All 4 platforms at once* in the AI window also fills in the Facebook post.

1. Open the **Facebook** tab in the side panel. Groups and Pages have separate lists: switch with **Groups | Pages**.
2. Add where to post:
   - **Import my Facebook groups** reads the groups you've joined (Facebook's "Your groups" page).
   - **Import Pages I manage** (on the Pages list) reads your Pages (Facebook's "Your Pages" page).
   - Or paste a group or Page link and click **Add**.
3. Tick groups and Pages, choose **Manual** or **Automatic**, then click **Post to …** (for example "Post to 3 groups + 1 Page"). The text comes from the Facebook post box; photos and videos come from the **Compose** tab.
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

## Instagram and X

Open the **IG & X** tab and pick **Instagram** or **X**.

**Instagram**

- **Feed post**: one photo makes a post, one video makes a Reel, and 2–10 photos/videos make a **carousel** (in the order shown; use ‹ › to reorder).
- **Story (beta)**: Instagram only offers Stories in its phone layout, so RitPost opens a small phone-sized Instagram window and adds your photo or video to your story. If Instagram doesn't show its story picker there, RitPost lets you save the photo and add it yourself. For a full-screen Story, use Studio → Crop → **Fit the whole photo** → **Story**.
- **Crop**: Original shape (keeps the crop you made in Studio), Portrait 4:5, Square 1:1 or Landscape 16:9. RitPost chooses it in Instagram's crop step.
- Instagram takes JPG, PNG or HEIC photos and MP4 or MOV videos. Saving a photo in Studio turns it into a JPG.

**X**

- Text, with up to 4 photos or 1 video or GIF.
- Over 280 characters? Turn on **thread**: RitPost splits the text between words (preferring sentence ends) into numbered posts (1/3, 2/3…). With **X Premium** ticked, long posts (up to 25,000 characters) go out as one post.
- The counter counts like X does: links count as 23 characters, emoji count double.

**Caption**

- **Same as Compose** (default) uses your Compose message, with WhatsApp marks (`*bold*`, `_italic_`) and `{group}` removed. Type in the caption box to write a separate caption for Instagram or for X.
- **Emoji** button, live **character counter** (2,200 on Instagram, with a hashtag count up to 30), and **# Hashtags**: save the hashtags you use often as sets and add them in one click.
- **Preview** shows how the post will look (Instagram card, carousel dots, Story frame, or the X thread).

**Edit before publishing**

**Review & post** opens a final check: the post preview and the caption, which you can still edit (with emoji), plus **Edit photos in Studio** and **Schedule instead**. Then:

- **Manual** (default): RitPost opens Instagram or X, adds the photos/videos, sets the crop and fills in the caption, then highlights **Share** / **Post**. You check it and click it; RitPost confirms when it's posted.
- **Automatic**: the same, then a review countdown (15 s by default) with **Share now**, **Hold** and **Cancel**, then RitPost clicks it.

RitPost posts to the Instagram and X accounts you're signed in to in Chrome. One Instagram/X post is prepared at a time; a corner panel on the site shows progress and any problem (for example a file Instagram refuses).

## RitPost Studio (photo editor)

Click **Edit** on a photo in Compose (or **Edit photos** / **Edit in Studio**). Studio opens in its own tab:

- **Crop**: Free, Original, 1:1, 4:5, 9:16 (Story/Reel), 16:9 and 1.91:1, with a draggable frame; rotate and flip.
- **Fit the whole photo**: keeps everything in the picture at 1:1, 4:5, 9:16 or 16:9 and fills the space with a blurred copy of the photo or a colour. One click turns any photo into a Story.
- **Filters**: 15 looks (Vivid, Warm, Cool, Golden, Bright, Dramatic, Vintage, Matte, Rose, Teal & Orange, Sunset, Fade, Mono, Noir…) previewed on your photo, each with a strength slider.
- **Adjust**: brightness, contrast, saturation, warmth, tint, fade, vignette and soft focus.
- **Text**: six fonts, five styles (plain, shadow, box, outline, neon), any colour, alignment, emoji in text.
- **Stickers**: emoji stickers (all of them, with search) and labels such as NEW, LIVE, SALE, JOIN US, LINK IN BIO or your own.
- **Draw**: pen, highlighter or neon.
- Drag text and stickers on the photo; the green handle resizes and rotates (snaps straight). Arrow keys nudge, Delete removes.
- **Undo/redo** (Ctrl+Z / Ctrl+Y), **Hold to compare** with the original, **Reset**.
- **Save photo** replaces the attachment with the edited JPG (up to 2160 px; small photos are brought up to 1080 px). The original and your edits are kept, so you can open it again and keep editing, or Reset and Save to go back to the original. **Save as copy** keeps both.
- Drag photos in Studio's left strip to change the order they're posted in.

Videos and documents are posted as they are.

## Your plan (free and premium)

RitPost is connected to the publisher's RitPost server (see `worker/README.md`). Everyone gets the **Free plan** with no setup; an **access code** unlocks a paid plan. The publisher decides in the admin portal what each plan includes:

- which platforms you can post to (WhatsApp, Facebook, Instagram, X) and **how many posts a day** on each,
- how many groups or Pages you can pick **in one run**,
- **AI rewrites** per day,
- **scheduled posts**, **Automatic mode** and **RitPost Studio**.

**Settings (⚙) → Your plan** shows your plan, how many posts and rewrites you have left today on each platform, and when your code expires. To activate a code: paste it under *Have an access code?* and click **Activate** (codes look like `RP-ABCD-EFGH-JKLM`). Most codes start counting down when you activate them, so a code bought today and activated next month still gives you its full time. **See plans & upgrade** lists the plans on offer and the publisher's **Get premium** link.

A small line under the Start button shows what's left for the platform you're posting to. If a run doesn't fit your plan (too many groups, today's posts used up, a platform or feature not included), RitPost explains why and how to upgrade before anything is opened. A "post" is one WhatsApp group, one Facebook group or Page, or one Instagram / X post; posts a stopped run didn't make are given back. Daily limits reset at midnight UTC. If the RitPost server can't be reached, RitPost uses the last plan it saw.

## AI writing assistant

AI rewrites are included in your plan (the Free plan has 30 a day by default); no OpenAI account or key is needed. Optionally describe **you / your brand voice** in **Settings → AI writing assistant** (for example "Ritworld Family Church, Accra. Warm, hopeful, faith-filled").

**Use it:** click **✨ AI** in the Compose toolbar (or in the Instagram/X caption box).

- **What should AI do?** Improve, Professional, Shorter, Expand, Fix grammar, Simpler, Persuasive, Headline + body, Translate.
- **Professional options:** write for WhatsApp, Facebook, Instagram, X (280 characters) or **all 4 platforms at once**; tone (Professional, Friendly, Formal, Persuasive, Inspirational, Urgent, Celebratory, Faith-filled…); type of post (announcement, event invitation, promotion, launch, reminder, thank-you, job vacancy, fundraising, church message…); audience; length; layout (paragraphs, bullet points, one idea per line, story); emojis; language (including Twi, Ewe, Hausa, Yoruba, Igbo, Swahili, Pidgin, French…); hashtags; strong opening hook; call to action with your own text; WhatsApp *bold*; keep links, dates, prices, names and `{group}` exactly; your brand voice; extra instructions.
- **Presets:** save the options you use often (for example "Church invite") and reuse them in one click. Your last options are remembered.
- **Results:** 3 different versions, each with a note on why it works and a character count. **Use this**, **Add below**, **Copy**, or **More like this** (3 new versions based on that one). With *all 4 platforms*, **Use all four** fills Compose and the Instagram and X captions at once. **Undo** always brings your text back.
- RitPost tells the AI never to invent facts, but always check names, dates and links before posting.

Your text is sent only when you click **Generate**: it goes to the RitPost server, which passes it to OpenAI and keeps only a usage log (no post text).

## Emoji

Every place you write has an emoji button: Compose, the Instagram/X caption, the review dialog and Studio's text tool. Search by word (heart, party, pray, ghana…), browse categories, pick a skin tone, and find your recently used ones first. Shift+click adds several at once.

## Scheduled posts

Post later, or on repeat, to WhatsApp groups, Facebook groups and Pages, Instagram or X.

1. Write your message (and attach files) in **Compose**, and select your groups (or Facebook groups and Pages), or set up your post in the **IG & X** tab.
2. Click the **clock** button next to Start, or **Schedule current message** in the **Scheduled** tab.
3. Choose WhatsApp, Facebook, Instagram or X, then the time (or a quick pick: *In 1 hour*, *Tonight 8 PM*, *Tomorrow 7 AM*, *Tomorrow noon*).
4. Optional:
   - **Repeat**: every day, weekdays (Mon–Fri) or chosen days of the week, and **Stop** after a number of times.
   - **How**: Manual or Automatic. A Manual schedule opens and fills everything, then waits for you. On Facebook you always click Post. An Automatic Instagram or X schedule posts after its review countdown, so it can go out while you're away.
   - **Remind me 5 minutes before**: a Chrome notification.
   - **If Chrome is closed or the computer is asleep at that time**: post when Chrome opens again (up to 6 hours late), or skip it and tell you.
   - **Name**, to find it easily.

The **Scheduled** tab lists what's coming, with **Post now**, **Pause / Resume**, **Edit** and **Delete** (with Undo). Finished ones can be scheduled again. **Recent activity** shows what started, what was missed and why. A notification tells you when a scheduled post starts.

Good to know:

- Chrome has to be open (it can be minimised) and the computer awake. RitPost opens WhatsApp Web, Facebook, Instagram or X by itself.
- A schedule keeps its own copy of the message, the selected groups and the files, so you can keep using Compose for other posts. To change what a schedule posts, Edit it and tick **Use the current Compose message, files and selection instead**.
- If another send session is still going when a schedule comes up, RitPost waits for it to finish (up to 2 hours).
- Automatic posting rules still apply: countdowns, Facebook's pauses between posts and daily limit.

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
- **Backup**: export or import your groups, lists, templates, Facebook groups and hashtag sets as JSON.
- **Reset**: delete all saved data.

## Privacy

Full policy: https://sirrjay.github.io/ritpost-whatsapp/store/privacy-policy.html


Your groups, messages, files and settings stay on your computer in `chrome.storage.local`. RitPost has no analytics or tracking. It only runs on `web.whatsapp.com`, `facebook.com`, `instagram.com` and `x.com`, and only acts there when you post from RitPost. RitPost Studio edits photos on your computer.

RitPost talks to one server, the publisher's RitPost server, for two things: **plan limits** (before a run it sends the platform, how many groups or posts are in it, a random device id and your access code; never the message, files or group names) and **AI rewrites** (when you click Generate, the text you asked it to rewrite and your brand voice, which the server passes to OpenAI). The server keeps a usage log (time, device id, plan, access code, counts, token counts, a hashed network address) for 90 days, but never your posts.

## Troubleshooting

- **"Group not found"**: the saved name doesn't exactly match the chat title in WhatsApp. Re-import the group, or fix the spelling. Archived chats only show up after you unarchive them.
- **Panel doesn't appear after updating the extension**: reload the WhatsApp Web tab.
- **The message didn't fill in**: click **Retry** or **Refill**. WhatsApp Web changes its page layout from time to time, and some selectors in `content/content.js` may need updating when it does.

## Project layout

```
manifest.json            Manifest V3 config
background.js            Side panel, finds or opens the WhatsApp/Facebook/Instagram/X tab, relays commands, checks plan limits, runs scheduled posts, saves backups
content/content.js       Opens chats, fills messages, notices sends, shows the progress panel
content/page-bridge.js   Tells groups apart from contacts when importing
content/facebook.js      Facebook: opens each group/Page, fills the post box, waits for you to click Post
popup/                   Compose, group manager, scheduling and settings UI (shown in the side panel)
lib/schedule.js          Repeat rules and time formatting shared by the panel and the background
lib/config.js            The RitPost server address
lib/ai.js, ai-prompt.js  Plan and AI client; the rewrite prompts (shared with the server)
worker/                  The RitPost server (Cloudflare Worker): plans, access codes, posting limits, AI, admin portal with team
icons/                   Extension icons
store/                   Chrome Web Store listing text, privacy policy and promo images
```
