# RitPost server

A small server on **Cloudflare Workers** (free plan) behind RitPost. It:

- runs **RitPost AI** for everyone, with your OpenAI key kept on the server (an encrypted Cloudflare secret, never in RitPost),
- holds your **plans** (Free for everyone, plus paid plans you design) and the **access codes** you sell,
- applies each plan's **posting limits** in RitPost: which platforms, posts per day, groups per run, scheduling, Automatic mode, Studio, AI rewrites,
- has an **admin portal** at `/admin` for you and your **team**.

```
RitPost (any user) ──► your server (plans, codes, limits, usage) ──► OpenAI (AI rewrites only)
```

## Set it up (about 5 minutes)

You need: your Cloudflare account, an OpenAI API key (platform.openai.com → API keys → Create new secret key), and Node.js installed.

In PowerShell:

```powershell
cd "C:\RitPost Whatsapp\worker"
.\deploy.ps1
```

The script:

1. Signs you in to Cloudflare (a browser window opens: click **Allow**).
2. Creates the database and its tables.
3. Deploys the server and shows its address, e.g. `https://ritpost-ai.your-name.workers.dev`.
4. Asks for your **OpenAI API key**: paste it, press Enter. It's stored encrypted on Cloudflare.
5. Asks you to choose an **admin password** for the portal.
6. Writes the server address into `lib/config.js`, so RitPost uses it.

Then reload RitPost at `chrome://extensions`. **Settings → Your plan** shows the Free plan with posts and rewrites left today.

If PowerShell refuses to run the script, run `Set-ExecutionPolicy -Scope Process Bypass` first (for that window only).

**Protect your spending:** in OpenAI → Settings → Limits, set a monthly budget. The portal also has an *AI rewrites for all users together per day* cap (5,000 by default).

## Update the server

```powershell
cd "C:\RitPost Whatsapp\worker"
npx wrangler@4 deploy
```

The database updates itself on the first request after an update (new tables and columns are added; nothing is lost). Your existing access codes move to the **Premium** plan and keep their limits.

## Admin portal

Open `https://<your-server>/admin`.

- **Owner (you):** leave the email empty and type the admin password. Or run `.\open-admin.ps1` in this folder: it opens the portal already signed in (a one-time link that works once, within 10 minutes; only a computer signed in to your Cloudflare account can make one).
- **Team members:** sign in with their email and the password they chose from their invite link.

### Dashboard

Sales this month (and today), active codes and how many expire within 7 days, posts today per platform, AI rewrites, active devices, AI cost (after you enter prices), 14-day charts for posts and AI, sales per plan, and **Run a test rewrite**.

### Plans

Each plan sets what a customer can do. The **Free** plan applies to everyone without a code; **Premium** is ready to sell; add as many as you like (**New plan**, or **Copy** an existing one).

- **Posting:** turn WhatsApp, Facebook, Instagram and X on or off, and set **posts per day** for each (empty = unlimited). A "post" is one WhatsApp group, one Facebook group or Page, or one Instagram / X post.
- **Groups / Pages in one run:** the most someone can pick at once.
- **AI rewrites per day** (0 = AI not included).
- **Scheduled posts**, **Automatic mode** and **RitPost Studio** on or off.
- **Devices per code** and **Codes last (days)** (the default expiry for new codes).
- **Name, price and description**, and whether RitPost **offers** the plan when someone reaches a limit.
- **Archive** a plan to stop selling it; customers on it keep it. A plan with no codes can be deleted.

Changes reach RitPost within a few minutes.

**Ideas:** keep Free useful but limited (for example WhatsApp 30 a day, Facebook 10, no Instagram/X, no Automatic mode), and sell e.g. *Starter* (WhatsApp + Facebook, 100 a day), *Pro* (all platforms, unlimited, AI) and *Business* (Pro on 5 devices).

### Access codes

**Sell an access code:** pick the plan (expiry and limits fill in), the customer's name, phone or email, the amount paid, a private note (e.g. the MoMo reference), and how many codes. Optionally change this customer's AI rewrites or devices. You get the code with a ready message to copy, or **Send on WhatsApp** (opens the chat directly when the phone number starts with `+` and the country code).

The list shows each code's plan, status, posts and AI used today, devices, expiry (codes expiring within 7 days are highlighted), amount paid, who sold it and last use. Search; filter by plan or status (including *Expiring in 7 days*); **Edit** (change plan, customer, amount, limits, expiry; **renew +30 days / +3 months / +1 year**; reset devices); **Disable / Enable**; **Delete**; **Export CSV**.

### Activity and devices

- **Activity → Posting:** every posting request from RitPost: allowed, refused (with the reason the customer saw) and posts given back by stopped runs. **AI rewrites:** the last 300 AI requests.
- **Devices:** the most active devices this week (posts and AI); block a device or a whole network, and unblock.

### Team

Add people to help you sell and support customers. **Add a team member** (name, email, role) gives you a sign-in link to send them; it works once, for 7 days. They open it, choose a password, and sign in with their email from then on.

| Role | Can |
|---|---|
| Owner | Everything, including the team and the owner password (you) |
| Admin | Everything except managing the team |
| Sales | Sell codes: create, edit, renew, turn off, reset devices; sees the dashboard |
| Support | Reset devices, turn codes on/off, block abusers; can't sell |
| Viewer | Look at everything, change nothing |

Tick **Only sees the codes they sell** for resellers or agents. The team list shows each person's codes sold and sales for the last 30 days. **Reset password** makes a new link; **Turn off** signs them out straight away; **Remove** deletes their account (their codes keep working). The **Activity log** records who did what (kept a year).

### Settings

Pause AI, free AI rewrites on/off, safety limits (free rewrites per network, all users per day, longest post), the AI model (automatic or chosen from your OpenAI account) and token prices, your business name and currency, and the messages shown in RitPost: announcement, upgrade message, and the **upgrade link** (e.g. your WhatsApp) behind the **Get premium** button. The owner can change the **owner password**; team members change **their own password** here.

## How customers use a code

RitPost → **Settings (⚙)** → **Your plan** → *Have an access code?* → paste → **Activate**. Codes look like `RP-ABCD-EFGH-JKLM` and work in any case or spacing. The box then shows their plan, what's left today on each platform, and the expiry date.

## Limits and safety

- Posting limits are checked before every run (and every scheduled post). A run that doesn't fit is refused before anything opens, with the reason and your upgrade options. Posts a stopped run didn't make are given back. If RitPost can't reach the server, it uses the last plan it saw (up to a week old) and never blocks posting otherwise.
- Free AI: per device per day (the Free plan), and 120 per network per day. Premium: per code per day, shared by the code's devices. Counters reset at midnight UTC.
- A rewrite that fails at OpenAI isn't counted. Posts longer than 3,000 characters are refused.
- The server only builds post-rewriting requests itself (it never forwards arbitrary prompts), only answers RitPost (Chrome extension) and its own admin page, and never returns your key.
- Passwords are stored as salted PBKDF2 hashes. Sign-ins last 12 hours. A network is locked out after 20 wrong passwords in a day.
- Logs (time, device id, plan, code, counts, tokens, hashed network, errors; **never post text**) are kept 90 days; the team activity log a year.

## Passwords

**Forgot the owner password, or always get "Wrong admin password"?** Run `.\set-admin-password.ps1` in this folder: it asks for a new password twice and saves it. Setting a new password also clears any wrong-password lockout. Team members who forget theirs: **Team → Reset password** and send them the new link.

Change the OpenAI key any time with `npx wrangler@4 secret put OPENAI_API_KEY`.
