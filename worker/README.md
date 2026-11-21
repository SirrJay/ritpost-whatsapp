# RitPost AI server

A small server on **Cloudflare Workers** (free plan) that lets everyone with RitPost use the AI writing assistant **without their own OpenAI key**. It holds your OpenAI key (as an encrypted Cloudflare secret, never in RitPost), gives everyone a **free daily allowance** (30 rewrites by default), and gives more to people with a **premium access code** you hand out. It has an **admin portal** at `/admin`.

```
RitPost (any user) ──► your server (holds the OpenAI key, counts usage) ──► OpenAI
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

Then reload RitPost at `chrome://extensions`. Open **Settings → AI writing assistant**: it shows **RitPost AI · Free plan: 30 of 30 rewrites left today**.

If PowerShell refuses to run the script, run `Set-ExecutionPolicy -Scope Process Bypass` first (for that window only).

**Protect your spending:** in OpenAI → Settings → Limits, set a monthly budget. The server also has an *all users together per day* cap (5,000 by default) in the portal.

## Admin portal

Open `https://<your-server>/admin` and sign in with your admin password.

- **Dashboard**: rewrites today (free/premium), active devices, cost today / 7 days (after you enter prices), active codes, errors, a 14-day chart, the model in use, and **Run a test rewrite**.
- **Access codes**: create codes for customers (name, rewrites per day, devices allowed, expiry such as 30 days / 3 months / 1 year / never, a private note such as the payment reference), one or many at a time. Each new code comes with a ready message to send your customer. The list shows today's use, devices, expiry, total uses and last use; search, filter, edit, disable/enable, reset devices (customer changed computer), delete, export CSV.
- **Activity**: the last 300 AI requests with plan, code, device, platform, model, tokens and errors.
- **Devices**: the most active devices this week; block a device or a whole network that abuses the free tier, and unblock.
- **Settings**: pause the service, turn the free tier on/off, free rewrites per device and per network, default premium limits, the all-users daily cap, longest post accepted, the AI model (automatic or chosen from your OpenAI account), token prices for the cost estimate, and messages shown in RitPost (announcement, upgrade message, upgrade link such as your WhatsApp).

## How customers use a code

RitPost → **Settings (⚙)** → **AI writing assistant** → *Have an access code?* → paste → **Activate**. Codes look like `RP-ABCD-EFGH-JKLM` and work in any case or spacing.

## Limits and safety

- Free: 30 rewrites per device per day, and 120 per network per day (so reinstalling doesn't give more). Premium: per code per day (300 by default), shared by up to 3 devices by default. Counters reset at midnight UTC.
- A rewrite that fails at OpenAI isn't counted. Posts longer than 3,000 characters are refused.
- The server only builds post-rewriting requests itself (it never forwards arbitrary prompts), only answers RitPost (Chrome extension) and its own admin page, and never returns your key.
- The admin portal locks a network after 20 wrong passwords in a day.
- Request logs (time, device id, plan, code, tokens, hashed network, errors; **not the post text**) are kept 90 days, then deleted automatically.

## Update the server later

```powershell
cd "C:\RitPost Whatsapp\worker"
npx wrangler@4 deploy
```

**Forgot the admin password, or always get "Wrong admin password"?** Run `.\set-admin-password.ps1` in this folder: it asks for a new password twice and saves it. Setting a new password also clears any wrong-password lockout.

Change the OpenAI key any time with `npx wrangler@4 secret put OPENAI_API_KEY`.
