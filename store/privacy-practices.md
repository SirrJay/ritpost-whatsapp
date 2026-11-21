# Privacy practices tab: answers to paste

## Single purpose

```
RitPost helps a user post one message to their own WhatsApp groups (WhatsApp Web), Facebook groups and Pages, Instagram account and X account, with a built-in photo editor, an AI writing assistant, an emoji picker, scheduling, and free/premium plans. It opens each selected group, fills in the message and attachments, and lets the user send or post it (on WhatsApp it can optionally send after a user-controlled countdown; on Facebook the user clicks Post, also in optional Automatic mode, where RitPost prepares each post after a review countdown with long pauses and a daily limit).
```

## Permission justifications

**storage**
```
Saves the user's WhatsApp groups and lists, Facebook groups and Pages, message templates, draft message and captions, attachments chosen for the next post, scheduled posts, settings and the last plan seen, locally in the browser.
```

**unlimitedStorage**
```
The user can attach photos, videos and documents (up to 16 MB each) to the post. They are kept in local extension storage until the user removes them, which can exceed the default 10 MB storage quota. Nothing is sent off the device.
```

**scripting**
```
Re-injects RitPost's own content script into an already-open WhatsApp Web tab after the extension is installed or updated, so the user doesn't have to reload WhatsApp Web. Only used on https://web.whatsapp.com/, https://*.facebook.com/, instagram.com and x.com.
```

**sidePanel**
```
RitPost's interface is a side panel docked beside WhatsApp Web or Facebook, so it stays open while messages are being posted.
```

**alarms**
```
Runs the posts the user schedules in RitPost's Scheduled tab at the time they chose (once or on repeat). One alarm per scheduled post, plus an optional reminder 5 minutes before.
```

**notifications**
```
Tells the user when a scheduled post starts, when one was missed (Chrome was closed or the computer asleep) or couldn't start, and the optional 5-minute reminder. Notifications are shown only for posts the user scheduled.
```

**declarativeNetRequestWithHostAccess**
```
Used only for Instagram Stories, and only in the small Story window RitPost opens when the user posts a Story. Instagram offers "Add to your story" only in its phone layout, so for that one tab RitPost sets a session rule that asks instagram.com for its phone layout (mobile browser headers). The rule is limited to that tab ID and removed as soon as the Story is posted or the window closes. No other tab, site or request is changed, and nothing is blocked or redirected.
```

**downloads**
```
Lets the user export a backup file (JSON) of their saved groups, lists and templates when they click "Export" in Settings.
```

**Host permission: https://web.whatsapp.com/***
```
Used only when the user posts to WhatsApp groups from RitPost. On WhatsApp Web it reads the chat list to import group names (when the user clicks Import), opens the chats the user selected, and fills in the user's message and any files the user attached. It does not read message history or contacts.
```

**Host permission: https://*.facebook.com/***
```
Used only when the user posts to Facebook from RitPost. RitPost opens the Facebook groups and Pages the user selected, opens the post box, fills in the user's message and attaches the photos/videos the user chose; the user clicks Post (in optional Automatic mode RitPost also clicks Next after a countdown the user can cancel; the user still clicks Post). For a Page, it clicks Facebook's "Switch now" so the post comes from the Page. When the user clicks "Import my Facebook groups" or "Import Pages I manage", it reads the names and links listed on Facebook's "Your groups" or "Your Pages" page. Nothing is sent anywhere else.
```

**Host permissions: https://www.instagram.com/*, https://instagram.com/*, https://*.cdninstagram.com/***
```
Used only when the user posts to Instagram from RitPost. RitPost opens Instagram's Create window, adds the photos/videos the user chose, picks the crop and fills in the caption; the user clicks Share (in optional Automatic mode RitPost clicks Share after a review countdown the user can hold or cancel). For a Story, it adds the user's photo in a phone-sized Instagram window (cdninstagram.com is included so that window's images load in the phone layout). It does not read the feed, messages or followers.
```

**Host permissions: https://x.com/*, https://twitter.com/***
```
Used only when the user posts to X from RitPost. RitPost opens X's composer, fills in the user's text (or a thread the user approved), adds the photos/video the user chose, and the user clicks Post (in optional Automatic mode RitPost clicks Post after a review countdown). It does not read the timeline, messages or followers.
```

**RitPost server (no host permission needed; the server allows RitPost's origin)**
```
RitPost has free and premium plans (premium is unlocked with an access code from the publisher). Before each posting run, RitPost asks the publisher's RitPost server (a Cloudflare Worker) whether the run fits the user's plan, sending only the platform, the number of groups/posts in the run, whether it is scheduled or automatic, a random device id and the access code if any (never message text, files or group names). When the user clicks Generate in the AI writing assistant, RitPost sends the text to rewrite and the chosen options to the same server, which calls OpenAI and returns the rewrites. The server stores no post text; it keeps a 90-day usage log (time, random device id, plan, access code, counts, token counts, hashed network address) to enforce plan limits.
```

## Remote code

**No, I am not using remote code.** All JavaScript is included in the package. RitPost loads no external scripts and uses no eval of downloaded code. Its server only answers plan checks and AI rewrites with data (JSON), never code.

## Data usage

RitPost reads **website content** (chat names and the message being written) on WhatsApp Web, the names and links of the user's Facebook groups (when the user imports them), and keeps any files the user attaches. Everything is processed and stored **only on the user's device**, with two exceptions: plan checks (platform, number of posts in a run, random device id, access code) sent to the publisher's RitPost server before each run, and, when the user clicks Generate in the AI writing assistant, the text they chose to rewrite, sent through the same server to OpenAI. The server keeps a usage log (no post text) to enforce plan limits.

Tick in the dashboard:

- [x] **Website content**: group names, Facebook group/Page links, message and caption text, attached and edited files: handled locally; text the user asks the AI assistant to rewrite is sent through the RitPost server to OpenAI
- [x] **User activity**: the number of posts per run and platform, sent to the RitPost server to apply plan limits
- [ ] Personally identifiable information
- [ ] Health information
- [ ] Financial and payment information
- [ ] Authentication information
- [ ] Personal communications. *If a reviewer asks, see the note below.*
- [ ] Location
- [ ] Web history

> Note: Google defines "collect" as transmitting data off the device. The only transmissions are the plan checks (post counts) and the user-initiated AI rewrite (through the RitPost server to OpenAI), which is why Website content and User activity are ticked above. If you'd rather be conservative, also tick **Personal communications**, since the tool composes messages. It does no harm when the privacy policy clearly says everything stays local.

Certify all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

```
https://sirrjay.github.io/ritpost-whatsapp/store/privacy-policy.html
```

This page is hosted with GitHub Pages from the public repository https://github.com/SirrJay/ritpost-whatsapp.
