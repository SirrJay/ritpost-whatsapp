# Privacy practices tab: answers to paste

## Single purpose

```
RitPost helps a user post one message to several of their own groups: WhatsApp groups in WhatsApp Web, and Facebook groups and Pages on facebook.com. It opens each selected group, fills in the message and attachments, and lets the user send or post it (on WhatsApp it can optionally send after a user-controlled countdown; on Facebook the user always clicks Post).
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
Re-injects RitPost's own content script into an already-open WhatsApp Web tab after the extension is installed or updated, so the user doesn't have to reload WhatsApp Web. Only used on https://web.whatsapp.com/ and https://*.facebook.com/.
```

**sidePanel**
```
RitPost's interface is a side panel docked beside WhatsApp Web or Facebook, so it stays open while messages are being posted.
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
Used only when the user posts to Facebook from RitPost. RitPost opens the Facebook groups and Pages the user selected, opens the post box, fills in the user's message and attaches the photos/videos the user chose; the user then clicks Post. When the user clicks "Import my Facebook groups", it reads the names and links of the groups listed on Facebook's "Your groups" page. Nothing is sent anywhere else.
```

## Remote code

**No, I am not using remote code.** All JavaScript is included in the package. RitPost loads no external scripts, uses no eval of downloaded code, and has no servers.

## Data usage

RitPost reads **website content** (chat names and the message being written) on WhatsApp Web, the names and links of the user's Facebook groups (when the user imports them), and keeps any files the user attaches. Everything is processed and stored **only on the user's device**. Nothing is transmitted to the developer or anyone else.

Tick in the dashboard:

- [x] **Website content**: handled locally only (group names, Facebook group/Page links, message text, attached files)
- [ ] Personally identifiable information
- [ ] Health information
- [ ] Financial and payment information
- [ ] Authentication information
- [ ] Personal communications. *If a reviewer asks, see the note below.*
- [ ] Location
- [ ] Web history
- [ ] User activity

> Note: Google defines "collect" as transmitting data off the device. RitPost transmits nothing. If you'd rather be conservative, also tick **Personal communications**, since the tool composes messages. It does no harm when the privacy policy clearly says everything stays local.

Certify all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

```
https://sirrjay.github.io/ritpost-whatsapp/store/privacy-policy.html
```

This page is hosted with GitHub Pages from the public repository https://github.com/SirrJay/ritpost-whatsapp.
