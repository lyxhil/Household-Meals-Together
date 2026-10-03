# Home Table

A Telegram bot that posts one pinned message per week. That message **is** the
board — a table anyone can read at a glance:

```
             Amber Ben Carol David
--------------------------------
> Mon Dinner  ✓    x    ·    ·
  Tue Dinner  ·    ·    ✓    ·
  Wed Dinner  ·    ·    ·    ·
  ...
✓ = eating in    · = have not indicated    x = not eating
```

No web app, no login, no cost. Columns aren't fixed — whoever links
themselves with `/iam` becomes a column, so the household can be any size.

---

## What you get

| | |
|---|---|
| **Sunday 10:00 SGT** | Bot posts and pins the new week. Every cell starts unset — nothing is pre-filled. |
| **The board** | Nine meals: Mon–Fri dinner, Sat/Sun lunch, Sat/Sun dinner. One column per person who has linked themselves. |
| **To change a meal** | Tap that meal's button. First tap says you're **in**; tap again for **out**; tap again for **in**. It only ever affects **you**. |
| **To change your whole week** | **I'm in all week** / **I'm out all week** |
| **Who can change what** | **Only your own.** Nobody can set anyone else's status, and nobody can silently take over someone else's name. |
| **Cut-offs** | 5pm same day for dinners, 11am same day for lunches |
| **Household size** | Not fixed. Anyone can join with `/iam`, and `/forget` removes someone who's no longer using it. |

Because nothing is pre-filled, everyone taps in every week that matters to
them — there's no more "usual" to coast on. That's the trade-off for not
hardcoding who's in the house.

### One-time step for each person

Because only you can change your own status, the bot needs to know which
Telegram account is which person. Each person sends this once, in the group,
with **any name they like**:

```
/iam Hil
```

`/whoami` confirms it. Until someone does this, tapping a meal tells them to
link first.

**Names aren't shared.** If a name is already linked to someone else's
Telegram account, `/iam` refuses rather than silently reassigning it — so one
person can never accidentally (or deliberately) become someone else on the
board. Two commands handle the edge cases:

- **You typed your own name wrong** — run `/iam` again with the corrected
  name. Since you're already linked as something, the bot asks you to
  confirm the switch first (buttons: *Yes* / *Cancel*) — confirming removes
  your old name from the board automatically, so you never end up as two
  columns at once.
- **Someone else is holding a name that should be yours** — ask them to send
  `/notme` (unlinks their own account, nothing else), then claim it.

> **Trade-off to be aware of.** Nobody can correct anyone else's status. If
> Hil tells Mum by voice that she's out and never taps, the board stays wrong
> and no one can fix it — her column just sits on "have not indicated" until
> she does. If that turns out to be common, the fix is to let Mum override;
> it's a small change.

---

## Get your own — about 5 minutes, once

Every household runs its **own** copy: your own bot, your own board, your
own data. Nothing is shared between households.

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
(that's where your bot actually runs) and a free
[GitHub account](https://github.com/signup) (the button below uses it to
make your own copy of the code). No terminal, no Node.js, nothing to
install.

### 1. Deploy

**[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-GITHUB-USERNAME/YOUR-REPO-NAME)**

Click it, sign into (or create) your Cloudflare account, and follow the
prompts. Partway through it'll ask you to fill in a few values —
`BOT_TOKEN`, `WEBHOOK_SECRET`, `WIDGET_KEY`. Skip ahead to step 2 to get
the first one, then come back and finish this.

- **`BOT_TOKEN`** — the token from step 2 below.
- **`WEBHOOK_SECRET`** — make up any random text of your own, e.g. `hometable-9f3k2x`.
- **`WIDGET_KEY`** — optional (only needed for the home-screen widget, see
  further down). Make up any random text, or leave it blank for now — you
  can add it later.

When it finishes, it gives you a URL like
`https://hometable-bot.yourname.workers.dev`. Keep that.

### 2. Create the bot

In Telegram, message [@BotFather](https://t.me/botfather):

```
/newbot
```

Give it a name (`Home Table`) and a username ending in `bot`
(e.g. `ourhometable_bot`). BotFather replies with a **token** — that's your
`BOT_TOKEN` above.

Then turn off privacy mode so the bot can see commands reliably:

```
/setprivacy
```

Pick your bot, choose **Disable**.

### 3. Connect it

Open this in any browser (using the URL from step 1):

```
https://hometable-bot.yourname.workers.dev/setup
```

You should see **✅ Connected!**.

### 4. Create the group

- Make a Telegram group with your household
- Add your bot to it
- **Promote the bot to admin** (needed to pin the board). Group settings →
  Administrators → Add. It only needs "Pin messages".

### 5. Start it

In the Telegram group, send:

```
/board
```

The board appears and pins itself. Done — it will re-post every Sunday at
10am.

> Prefer the command line over clicking buttons? See
> [MANUAL-DEPLOY.md](./MANUAL-DEPLOY.md) for the Node.js/Wrangler route instead.

---

## Commands

| Command | What it does |
|---|---|
| `/iam NAME` | Link your Telegram account to a name of your choosing. Everyone does this once. |
| `/whoami` | Check who you're linked as |
| `/notme` | Unlink yourself — frees your name for anyone (e.g. the real owner) to claim |
| `/forget NAME` | Remove someone with no linked account from the board entirely |
| `/board` | Post and pin this week's board |
| `/tonight` | The next meal, as a fresh message |
| `/nextweek` | Start next week's board early |
| `/thisweek` | Jump back to the week in progress (e.g. after `/nextweek` was sent early) |
| `/link` | Home-screen setup instructions and deep links |
| `/help` | What the bot does, plus who's on the board and the cut-offs |

---

## Home screen widget

A widget shows the count for the **upcoming meal** without opening anything.
Tapping it opens the board in Telegram.

"Upcoming" rolls forward on its own schedule, separate from the board's
change-cutoffs above:

| | |
|---|---|
| **Dinner stays the focus until** | 8pm |
| **Lunch stays the focus until** | 2pm |

Once that passes, the widget moves on to the next meal on the calendar —
including rolling into next week late on a Sunday night (e.g. 9pm Sunday
shows Monday's dinner, not Sunday's).

### Enable the data feed first

If you didn't set `WIDGET_KEY` when deploying: open your Worker in the
[Cloudflare dashboard](https://dash.cloudflare.com/) → **Settings** →
**Variables and Secrets** → **Add** → name it `WIDGET_KEY`, type any random
string (e.g. `wk-4m2p9x`) as the value → **Save**. Takes effect immediately,
no redeploy needed.

Test it in a browser:
```
https://hometable-bot.<your-subdomain>.workers.dev/today.json?k=<your-widget-key>
```
You should see JSON. Without the key it returns 403; without `WIDGET_KEY` set
at all the feed is off entirely.

### iPhone — Scriptable

1. Install **Scriptable** (free, App Store)
2. Open it → **+** → paste the contents of `HomeTableWidget.js`
3. Edit the two lines at the top: your worker URL and your widget key
4. Name the script **Home Table** → Done
5. Tap ▶ to preview. You should see today's count.
6. Long-press your home screen → **+** → **Scriptable** → small widget → Add
7. Long-press the new widget → **Edit Widget** → Script: **Home Table**

### Android — a JSON widget app

Android has no Scriptable. Use a generic JSON widget app pointed at the same
URL — [Simple JSON Widget](https://play.google.com/store/apps/details?id=sk.blackruby.simplejsonwidget)
or [Data Widget](https://play.google.com/store/apps/details?id=name.xoid.datawidget).
Point it at your `/today.json?k=...` URL and map the field `focus.count`,
or `focus.in` for the names.

Less pretty than the iOS one, and configuration differs per app.

### Widget limitations — read before relying on it

| | |
|---|---|
| **Not live** | iOS decides when widgets refresh, typically every 15–30 min. A change made 2 minutes ago may not show yet. |
| **No in-widget editing** | Only native apps get interactive widget buttons. The "edit" chip opens Telegram — one tap, but it's a jump, not an inline toggle. |
| **Key is stored in plain text** on each phone. It only grants read access to the meal board, but treat it as semi-public. |
| **Per-phone setup** | Each person installs and configures separately. No way around this. |

---

## Home screen icon

`/link`, sent in the group, now leads with the **widget** above when
`WIDGET_KEY` is set — it prints the exact `WORKER_URL`/`WIDGET_KEY` values
to paste in, so nobody has to hunt for them. This plain-icon method is the
fallback for anyone who'd rather not install anything: it just opens the
chat, with no live count.

`icon.png` in this folder is a 1024×1024 icon designed to survive both
platforms' cropping. Send it to everyone, or use your own picture.

### Android — 30 seconds, no link needed

Telegram does this natively:

1. Settings → Chats → turn on **Home screen shortcuts** (first time only)
2. Open the group → tap the group name at the top
3. Tap **⋮** → **Add to home screen**

The icon is the group's photo, so set the group photo to `icon.png` first
and everyone gets it automatically.

### iPhone — about 2 minutes each

iOS has no native "pin a chat to the home screen", so you go through
Shortcuts. In the group, send `/link` — the bot prints the exact link for
your group. Then on each iPhone:

1. Save `icon.png` to Photos
2. Open **Shortcuts** → **+** → **Add Action** → search **Open URL**
3. Paste the `tg://privatepost?...` link the bot gave you
4. Tap the **dropdown/chevron at the top** of the shortcut editor →
   **Add to Home Screen** directly — this same panel also lets you rename
   it and pick `icon.png` as its icon
5. If your iOS version doesn't show that option: tap the shortcut name at
   the top → rename to **Home Table** → share icon → **Add to Home
   Screen** → tap the icon thumbnail → **Choose Photo** → pick
   `icon.png` → **Add**

Tapping it opens Telegram straight at the pinned board.

> **If the `tg://` link doesn't work**, use the `https://t.me/c/...` link
> instead — it takes one extra moment because it bounces through Safari.
>
> **If `/link` says you're still a basic group**, Telegram hasn't upgraded
> it to a supergroup yet. Direct message links need a supergroup. Until then,
> use **Open App → Telegram** as the shortcut action; the pinned board is one
> tap from the top of the chat. Run `/link` again later.

---

## Changing things later

Who's on the board is no longer a setting — it's whoever has run `/iam`
(see `/forget` above to remove someone). Everything else lives at the top of
`worker.js`:

| Setting | Line |
|---|---|
| Cut-off times | `CUTOFF_HOUR` |
| Meals tracked | `MEALS` |
| Longest allowed name | `MAX_NAME_LEN` |
| Reject late changes | `ENFORCE_CUTOFF = true` |
| Legend marks | `MARK_IN` / `MARK_UNSET` / `MARK_OUT` |

Deployed via the button, your Worker is connected to your own GitHub copy of
this code — edit `worker.js` right on github.com (click the pencil icon on
the file) and commit. Cloudflare picks up the change and redeploys
automatically within a minute or two; check the **Deployments** tab on your
Worker if you want to watch it happen or trigger it by hand.

Prompt time lives in `wrangler.toml` under `crons`. It's in UTC, so
`"0 2 * * SUN"` is Sunday 10:00 SGT.

⚠️ Cloudflare's day-of-week runs **1 = Sunday to 7 = Saturday**, unlike most
cron systems where 0 = Sunday. Use the three-letter abbreviations
(`SUN`, `MON`, …) and the question doesn't arise.
[Cloudflare cron docs](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

---

## Known limitations

| | |
|---|---|
| **Late changes are allowed** | After a cut-off the bot warns but still accepts the change. Set `ENFORCE_CUTOFF = true` to block instead. |
| **No conflict handling** | If two people tap in the same second, last write wins. Fine for a household-sized group; would matter at scale. |
| **Nobody can cover for anyone** | By design. A person who doesn't tap stays "have not indicated", and no one else can set it for them. |
| **Old columns don't clean themselves up** | If someone stops using the bot without running `/notme`, their column stays until someone runs `/notme` (them) then `/forget NAME` (anyone). |
| **Buttons can't show your own state** | Telegram keyboards are identical for every viewer, so a button can't say "you're in". The table above it carries that. |
| **Long names widen the table** | Initials keep it inside one phone width. Full names may wrap on narrow screens. |
| **Bot must stay admin** | If it loses admin, the board still works but stops pinning. |

---

## Cost

Free. Cloudflare Workers free tier is 100,000 requests/day and KV is
100,000 reads + 1,000 writes/day. A household uses roughly 20 writes/day.
Telegram bots are free with no message charges.
