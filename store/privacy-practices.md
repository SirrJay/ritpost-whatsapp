# Privacy practices tab: answers to paste

## Single purpose

```
RitPost helps a user post one message to their own WhatsApp groups (WhatsApp Web), Facebook groups and Pages, Instagram account and X account, with a built-in photo editor, an optional AI writing assistant (the user's own OpenAI account), an emoji picker and scheduling. It opens each selected group, fills in the message and attachments, and lets the user send or post it (on WhatsApp it can optionally send after a user-controlled countdown; on Facebook the user clicks Post, also in optional Automatic mode, where RitPost prepares each post after a review countdown with long pauses and a daily limit).
```

## Permission justifications

**storage**
```
Saves the user's group list, saved selections, message templates, draft message, attachments chosen for the next post, settings and last-session summary locally in the browser. Nothing is sent off the device.
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
RitPost works only on WhatsApp Web. It reads the chat list to import group names, opens the chats the user selected, and fills in the user's message and any files the user attached. It runs on no other site.
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

**Host permission: https://api.openai.com/***
```
Used only by the optional AI writing assistant, with the user's own OpenAI API key. When the user clicks "Check & save", RitPost lists the models in their account; when the user clicks "Generate", it sends the post text they asked to rewrite (and their optional brand-voice note) to OpenAI and shows the rewrites. Nothing is sent otherwise.
```

## Remote code

**No, I am not using remote code.** All JavaScript is included in the package. RitPost loads no external scripts, uses no eval of downloaded code, and has no servers.

## Data usage

RitPost reads **website content** (chat names and the message being written) on WhatsApp Web, the names and links of the user's Facebook groups (when the user imports them), and keeps any files the user attaches. Everything is processed and stored **only on the user's device**, with one user-initiated exception: if the user sets up the optional AI writing assistant with their own OpenAI API key, the text they choose to rewrite is sent to OpenAI when they click Generate. Nothing is transmitted to the developer.

Tick in the dashboard:

- [x] **Website content**: group names, Facebook group/Page links, message and caption text, attached and edited files: handled locally; message text is sent to OpenAI only when the user uses the optional AI assistant with their own key
- [x] **Authentication information**: the user's own OpenAI API key, stored locally and sent only to api.openai.com
- [ ] Personally identifiable information
- [ ] Health information
- [ ] Financial and payment information
- [ ] Authentication information
- [ ] Personal communications. *If a reviewer asks, see the note below.*
- [ ] Location
- [ ] Web history
- [ ] User activity

> Note: Google defines "collect" as transmitting data off the device. RitPost transmits nothing to the developer; the only transmission is the optional, user-initiated AI rewrite sent to OpenAI with the user's own key, which is why Website content and Authentication information are ticked above. If you'd rather be conservative, also tick **Personal communications**, since the tool composes messages. It does no harm when the privacy policy clearly says everything stays local.

Certify all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

```
https://sirrjay.github.io/ritpost-whatsapp/store/privacy-policy.html
```

This page is hosted with GitHub Pages from the public repository https://github.com/SirrJay/ritpost-whatsapp.
