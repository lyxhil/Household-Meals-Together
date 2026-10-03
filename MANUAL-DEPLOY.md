# Manual deploy (command line)

This is the alternative to the "Deploy to Cloudflare" button in
[README.md](./README.md) — same result, but driven from a terminal instead
of clicking through the Cloudflare dashboard. Use this if you'd rather have
full control, the button isn't working for some reason, or you're just more
comfortable in a terminal than a browser.

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
and Node.js installed.

### 1. Create the bot

In Telegram, message [@BotFather](https://t.me/botfather):

```
/newbot
```

Give it a name (`Home Table`) and a username ending in `bot`
(e.g. `ourhometable_bot`). BotFather replies with a **token** — keep it.

Then turn off privacy mode so the bot can see commands reliably:

```
/setprivacy
```

Pick your bot, choose **Disable**.

### 2. Create the group

- Make a Telegram group with your household
- Add your bot to it
- **Promote the bot to admin** (needed to pin the board). Group settings →
  Administrators → Add. It only needs "Pin messages".

### 3. Deploy

In this folder:

```bash
npx wrangler login
```

A browser window opens — approve the access. (`npx` fetches wrangler on
demand, so there's nothing to install globally.)

Deploy:

```bash
npx wrangler deploy
```

The first time, Wrangler notices `wrangler.toml` has no KV namespace `id`
and offers to create one for you — say yes. It then prints a URL like
`https://hometable-bot.yourname.workers.dev`. Keep it.

Now set your two secrets:

```bash
npx wrangler secret put BOT_TOKEN
# paste the token from BotFather

npx wrangler secret put WEBHOOK_SECRET
# make up any random string, e.g. hometable-9f3k2x — you'll need it once more
```

Secrets apply immediately; no need to redeploy.

### 4. Point Telegram at it

No terminal needed for this part — open this in any browser (using the
URL Wrangler printed in step 3):

```
https://hometable-bot.yourname.workers.dev/setup
```

You should see **✅ Connected!**.

### 5. Start it

In the Telegram group, send:

```
/board
```

The board appears and pins itself. Done — it will re-post every Sunday at
10am.

### Changing settings later

Everything lives at the top of `worker.js`. Edit it locally, then:

```bash
npx wrangler deploy
```

### The widget, deployed this way

```bash
npx wrangler secret put WIDGET_KEY
# type any random string, e.g. wk-4m2p9x

npx wrangler deploy
```

Then follow the "Home screen widget" section in [README.md](./README.md)
as normal.
