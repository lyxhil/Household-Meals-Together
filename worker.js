/**
 * Home Table — family meal attendance bot
 * Cloudflare Worker + Telegram Bot API
 *
 * One pinned group message is the shared board. It shows a table:
 * one row per meal, one column per person.
 *
 * Rules:
 *  - You can only change YOUR OWN status. No overwriting anyone else.
 *  - Tapping a meal button toggles whether YOU are eating at home.
 *  - Each person links themselves once with /iam <name of their choosing>.
 *  - Household membership is not hardcoded: whoever /iam's becomes a column.
 *    /notme frees your own name; /forget NAME removes an unclaimed one.
 *
 * Each cell is tri-state, not a toggle between two values:
 *   unset  — nobody has said anything for that meal yet (the default)
 *   in     — that person said they're eating at home
 *   out    — that person said they're not
 * Tapping cycles unset/out -> in -> out (never back to unset — once you've
 * said something, silence isn't the right way to read your answer anymore).
 *
 * Meals: Mon–Fri dinner, Sat/Sun lunch, Sat/Sun dinner (9 per week).
 * Weekly prompt: Sunday 10:00 SGT for the week starting the next day.
 * Cut-offs: 17:00 same day (dinner), 09:00 same day (lunch).
 */

// ---------------------------------------------------------------- config

const CUTOFF_HOUR = { lunch: 11, dinner: 17 };

// false = warn but still accept a late change. true = reject after cut-off.
const ENFORCE_CUTOFF = false;

// Longest a chosen name may be — names are column headers, so an unbounded
// name would blow out the table width on a phone screen.
const MAX_NAME_LEN = 14;

// Marks used in the board table. Kept to single-width characters so the
// columns stay aligned inside Telegram's monospace block. Emoji are
// double-width on some platforms and break the grid.
const MARK_IN = '✓'; // said they're eating at home
const MARK_UNSET = '·'; // said nothing yet
const MARK_OUT = 'x'; // said they're not eating at home

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

const MEALS = [
  { key: 'mon-d', dow: 1, type: 'dinner', day: 'Mon' },
  { key: 'tue-d', dow: 2, type: 'dinner', day: 'Tue' },
  { key: 'wed-d', dow: 3, type: 'dinner', day: 'Wed' },
  { key: 'thu-d', dow: 4, type: 'dinner', day: 'Thu' },
  { key: 'fri-d', dow: 5, type: 'dinner', day: 'Fri' },
  { key: 'sat-l', dow: 6, type: 'lunch', day: 'Sat' },
  { key: 'sat-d', dow: 6, type: 'dinner', day: 'Sat' },
  { key: 'sun-l', dow: 0, type: 'lunch', day: 'Sun' },
  { key: 'sun-d', dow: 0, type: 'dinner', day: 'Sun' },
];

const MEAL_BY_KEY = Object.fromEntries(MEALS.map((m) => [m.key, m]));

function mealLabel(m) {
  return `${m.day} ${m.type === 'lunch' ? 'Lunch' : 'Dinner'}`;
}

// ---------------------------------------------------------------- time

function sgtNow() {
  return new Date(Date.now() + SGT_OFFSET_MS);
}

function mondayOf(d) {
  const daysSinceMon = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - daysSinceMon * 86400000)
    .toISOString()
    .slice(0, 10);
}

function nextMondayOf(d) {
  const dow = d.getUTCDay();
  const daysToMon = dow === 0 ? 1 : (8 - dow) % 7 || 7;
  return new Date(d.getTime() + daysToMon * 86400000).toISOString().slice(0, 10);
}

function mealDate(weekStart, meal) {
  const mon = new Date(weekStart + 'T00:00:00Z');
  const offset = meal.dow === 0 ? 6 : meal.dow - 1;
  return new Date(mon.getTime() + offset * 86400000);
}

// `hours` defaults to the board's own change-cutoffs (CUTOFF_HOUR). The
// widget uses a different, later cutoff scheme (see WIDGET_CUTOFF_HOUR
// below) to decide which meal is "upcoming" — that's a separate question
// from when you're still allowed to change your own status.
function cutoffAt(weekStart, meal, hours = CUTOFF_HOUR) {
  const d = mealDate(weekStart, meal);
  return d.getTime() + hours[meal.type] * 3600000 - SGT_OFFSET_MS;
}

function isPastCutoff(weekStart, meal, hours = CUTOFF_HOUR) {
  return Date.now() > cutoffAt(weekStart, meal, hours);
}

function fmtDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function fmtCutoff(meal) {
  const h = CUTOFF_HOUR[meal.type];
  return h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
}

function currentMeal(weekStart) {
  for (const m of MEALS) if (!isPastCutoff(weekStart, m)) return m;
  return null;
}

function mealsOnDate(weekStart, isoDate) {
  return MEALS.filter(
    (m) => mealDate(weekStart, m).toISOString().slice(0, 10) === isoDate,
  );
}

// Widget-only: which meal counts as "upcoming" rolls later than the
// board's own change-cutoffs — dinner stays the focus until 8pm, lunch
// until 2pm, and once that's passed the widget moves on to the next
// meal on the calendar (which may be the next day, or next week's
// Monday dinner late on a Sunday night).
const WIDGET_CUTOFF_HOUR = { lunch: 14, dinner: 20 };

function addWeek(weekStart) {
  return new Date(new Date(weekStart + 'T00:00:00Z').getTime() + 7 * 86400000)
    .toISOString()
    .slice(0, 10);
}

function upcomingWidgetMeal() {
  let weekStart = mondayOf(sgtNow());
  // The furthest a search should ever need to look is one meal into the
  // following week (immediately after Sunday dinner's cutoff), so two
  // weeks is a safe bound rather than an open-ended loop.
  for (let hop = 0; hop < 2; hop++) {
    for (const m of MEALS) {
      if (!isPastCutoff(weekStart, m, WIDGET_CUTOFF_HOUR)) {
        return { weekStart, meal: m };
      }
    }
    weekStart = addWeek(weekStart);
  }
  return null;
}

// ---------------------------------------------------------------- state

// New weeks start with every cell unset — there is no "usual" pre-fill any
// more, because with a flexible member list there is no fixed roster to
// have a usual for. See the tri-state note at the top of the file.
function freshWeek(weekStart, members) {
  const meals = {};
  for (const m of MEALS) {
    meals[m.key] = {};
    for (const p of members) meals[m.key][p] = { state: null, by: null };
  }
  return { weekStart, meals, createdAt: Date.now() };
}

async function getWeek(env, weekStart, members) {
  const raw = await env.HOMETABLE.get(`week:${weekStart}`);
  if (raw) return JSON.parse(raw);
  const w = freshWeek(weekStart, members);
  await putWeek(env, w);
  return w;
}

async function putWeek(env, week) {
  await env.HOMETABLE.put(`week:${week.weekStart}`, JSON.stringify(week), {
    expirationTtl: 60 * 60 * 24 * 60,
  });
}

async function getConfig(env) {
  const raw = await env.HOMETABLE.get('config');
  const cfg = raw ? JSON.parse(raw) : {};
  if (!cfg.people) cfg.people = {}; // telegramUserId -> member name
  if (!cfg.members) cfg.members = []; // ordered list of household member names
  return cfg;
}

async function putConfig(env, cfg) {
  await env.HOMETABLE.put('config', JSON.stringify(cfg));
}

/** The Telegram account (if any) currently holding a member name. */
function holderOf(cfg, name) {
  return Object.keys(cfg.people).find((id) => cfg.people[id] === name) || null;
}

// ---------------------------------------------------------------- render

// A cell may not exist yet (e.g. a member added after this week was
// created) — that reads as unset, same as an explicit null state.
function cellState(week, mealKey, person) {
  const cell = week.meals[mealKey] && week.meals[mealKey][person];
  return cell ? cell.state : null;
}

function cellMark(week, mealKey, person) {
  const state = cellState(week, mealKey, person);
  if (state === 'in') return MARK_IN;
  if (state === 'out') return MARK_OUT;
  return MARK_UNSET;
}

function countIn(week, mealKey, members) {
  return members.filter((p) => cellState(week, mealKey, p) === 'in').length;
}

function namesIn(week, mealKey, members) {
  return members.filter((p) => cellState(week, mealKey, p) === 'in');
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
}

function pad(s, width) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function centre(s, width) {
  s = String(s);
  const left = Math.max(0, Math.floor((width - s.length) / 2));
  return ' '.repeat(left) + s + ' '.repeat(Math.max(0, width - s.length - left));
}

/**
 * The board: a monospace table, rows = meals, columns = people.
 * `members` is the CURRENT household list (from config), independent of
 * whatever this particular week's stored cells happen to contain.
 */
function renderWeek(week, members) {
  const mon = new Date(week.weekStart + 'T00:00:00Z');

  if (!members.length) {
    return (
      `🍽 <b>Home Table</b> — week of ${fmtDate(mon)}\n\n` +
      `Nobody's linked yet. Send <code>/iam YourName</code> to join — ` +
      `pick any name, it becomes your column on the board.`
    );
  }

  // A week that hasn't begun has no "next meal" worth pointing at — every
  // meal is still ahead, so the marker would just sit on Monday and read
  // as though today were Monday.
  const isFutureWeek = week.weekStart > mondayOf(sgtNow());
  const cur = isFutureWeek ? null : currentMeal(week.weekStart);

  // One uniform column width keeps marks under their names on every device.
  const labelW = Math.max(...MEALS.map((m) => mealLabel(m).length)) + 2;
  const colW = Math.max(4, ...members.map((p) => p.length + 1));

  let grid = pad('', labelW) + members.map((p) => centre(p, colW)).join('');
  grid += '\n' + '-'.repeat(labelW + colW * members.length);

  for (const m of MEALS) {
    const isNow = cur && cur.key === m.key;
    const name = (isNow ? '> ' : '  ') + mealLabel(m);
    let line = pad(name, labelW);
    line += members.map((p) => centre(cellMark(week, m.key, p), colW)).join('');
    grid += '\n' + line.replace(/\s+$/, '');
  }

  let out = `🍽 <b>Home Table</b> — week of ${fmtDate(mon)}\n`;
  out += `<pre>${esc(grid)}</pre>\n`;
  out += `${MARK_IN} = eating in    ${MARK_UNSET} = have not indicated    ${MARK_OUT} = not eating`;

  if (cur) {
    const names = namesIn(week, cur.key, members).join(', ') || 'nobody yet';
    out += `\n\n<b>Next: ${mealLabel(cur)}</b> — ${countIn(week, cur.key, members)} at home`;
    out += `\n${esc(names)}  <i>(change by ${fmtCutoff(cur)})</i>`;
  } else if (isFutureWeek) {
    out += `\n\n<b>Starts ${fmtDate(mon)}</b> — nothing has happened yet.`;
  } else {
    out += `\n\nAll meals this week have passed. Send /nextweek.`;
  }

  out += `\n\n<i>Tap a meal below to switch YOURSELF in or out.`;
  out += `\nYou can only change your own.</i>`;
  return out;
}

function weekKeyboard(week) {
  const rows = [];
  let row = [];
  for (const m of MEALS) {
    const past = isPastCutoff(week.weekStart, m);
    row.push({
      text: `${past ? '· ' : ''}${mealLabel(m)}`,
      callback_data: `x:${m.key}`,
    });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([
    { text: "I'm in all week", callback_data: 'me:1' },
    { text: "I'm out all week", callback_data: 'me:0' },
  ]);
  rows.push([{ text: '🔄 Refresh', callback_data: 'w' }]);
  return { inline_keyboard: rows };
}

/** One meal, spelled out — used by /tonight. */
function renderMeal(week, meal, members) {
  const d = mealDate(week.weekStart, meal);
  const past = isPastCutoff(week.weekStart, meal);

  let out = `<b>${mealLabel(meal)}</b> · ${fmtDate(d)}\n`;
  out += past
    ? `<i>Cut-off (${fmtCutoff(meal)}) has passed</i>\n\n`
    : `<i>Change by ${fmtCutoff(meal)}</i>\n\n`;
  for (const p of members) {
    out += `${cellMark(week, meal.key, p)} <b>${esc(p)}</b>\n`;
  }
  const names = namesIn(week, meal.key, members).join(', ') || 'nobody yet';
  out += `\n<b>${countIn(week, meal.key, members)} at home</b> — ${esc(names)}`;
  return out;
}

function mealKeyboard(meal) {
  return {
    inline_keyboard: [
      [{ text: `I'm in / out — ${mealLabel(meal)}`, callback_data: `x:${meal.key}` }],
      [{ text: '← Full week', callback_data: 'w' }],
    ],
  };
}

// ---------------------------------------------------------------- telegram

async function tg(env, method, payload) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  const json = await res.json();
  if (!json.ok) console.log(`tg ${method} failed:`, JSON.stringify(json));
  return json;
}

async function showWeek(env, chatId, messageId, week, members) {
  return tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: renderWeek(week, members),
    parse_mode: 'HTML',
    reply_markup: weekKeyboard(week),
  });
}

async function postBoard(env, chatId, weekStart) {
  const cfg = await getConfig(env);
  const week = await getWeek(env, weekStart, cfg.members);
  const sent = await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: renderWeek(week, cfg.members),
    parse_mode: 'HTML',
    reply_markup: weekKeyboard(week),
  });
  if (!sent.ok) return null;
  const messageId = sent.result.message_id;

  await tg(env, 'unpinAllChatMessages', { chat_id: chatId });
  await tg(env, 'pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: false,
  });

  cfg.chatId = chatId;
  cfg.messageId = messageId;
  cfg.weekStart = weekStart;
  await putConfig(env, cfg);
  return messageId;
}

// ---------------------------------------------------------------- handlers

async function handleCallback(env, cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data || '';
  const userId = String(cb.from.id);

  const cfg = await getConfig(env);
  const weekStart = cfg.weekStart || mondayOf(sgtNow());
  const week = await getWeek(env, weekStart, cfg.members);

  const ack = (text, alert = false) =>
    tg(env, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      ...(text ? { text, show_alert: alert } : {}),
    });

  if (data === 'w') {
    await showWeek(env, chatId, messageId, week, cfg.members);
    return ack();
  }

  // Confirmed/cancelled response to a /iam rename prompt (see handleMessage).
  if (data.startsWith('iamY:') || data === 'iamN') {
    const oldName = cfg.people[userId];
    if (data === 'iamN' || !oldName) {
      await tg(env, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: oldName ? 'Cancelled — no change made.' : 'That rename request is no longer valid.',
      });
      return ack();
    }
    const newName = data.slice('iamY:'.length);
    // Someone else may have grabbed the new name between the prompt and
    // this tap — re-check rather than trusting what the button captured.
    const holderId = holderOf(cfg, newName);
    if (holderId && holderId !== userId) {
      await tg(env, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        text: `<b>${esc(newName)}</b> was just claimed by someone else — try a different name.`,
      });
      return ack();
    }
    cfg.people[userId] = newName;
    if (!cfg.members.includes(newName)) cfg.members.push(newName);
    // The old name is this account's alone, so it's safe to drop unless
    // someone else has since claimed it too.
    if (!holderOf(cfg, oldName)) {
      cfg.members = cfg.members.filter((p) => p !== oldName);
    }
    await putConfig(env, cfg);
    await tg(env, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      text: `✅ You're now <b>${esc(newName)}</b>. <b>${esc(oldName)}</b> has been removed from the board.`,
    });
    return ack();
  }

  // Everything below changes someone's status, so we must know who is tapping.
  const me = cfg.people[userId];
  if (!me) {
    return ack(
      'First link yourself — send in the chat:\n/iam YourName' +
      (cfg.members.length ? `\n\nAlready on the board: ${cfg.members.join(', ')}` : ''),
      true,
    );
  }

  // Toggle MY status for one meal: unset/out -> in -> out.
  if (data.startsWith('x:')) {
    const meal = MEAL_BY_KEY[data.slice(2)];
    if (!meal) return ack('Unknown meal');

    const past = isPastCutoff(weekStart, meal);
    if (past && ENFORCE_CUTOFF) {
      return ack(`Cut-off for ${mealLabel(meal)} has passed`, true);
    }

    const wasIn = cellState(week, meal.key, me) === 'in';
    const next = wasIn ? 'out' : 'in';
    week.meals[meal.key][me] = { state: next, by: me };
    await putWeek(env, week);
    await showWeek(env, chatId, messageId, week, cfg.members);
    return ack(
      `${mealLabel(meal)}: you're ${next === 'in' ? 'IN' : 'OUT'}` +
      (past ? ' (after cut-off)' : ''),
    );
  }

  // Set my whole week explicitly in or out.
  if (data.startsWith('me:')) {
    const target = data.slice(3) === '1' ? 'in' : 'out';
    for (const m of MEALS) {
      week.meals[m.key][me] = { state: target, by: me };
    }
    await putWeek(env, week);
    await showWeek(env, chatId, messageId, week, cfg.members);
    return ack(`You're ${target === 'in' ? 'IN' : 'OUT'} for the whole week`);
  }

  return ack();
}

async function handleMessage(env, msg, origin) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  const parts = text.split(/\s+/);
  const cmd = parts[0].split('@')[0].toLowerCase();
  const userId = String(msg.from.id);
  const firstName = msg.from.first_name || msg.from.username || 'someone';

  // Link a Telegram account to a household member. Anyone can pick their
  // own name — there's no fixed roster — but a name already claimed by a
  // DIFFERENT Telegram account can't be silently taken over. Correcting
  // your own mistake (re-running /iam for yourself) always works.
  if (cmd === '/iam') {
    const wanted = (parts[1] || '').trim();
    const cfg = await getConfig(env);

    if (!wanted) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text:
          '<b>Tell me your name:</b>\n<code>/iam YourName</code>' +
          (cfg.members.length
            ? `\n\nAlready on the board: ${esc(cfg.members.join(', '))}`
            : ''),
      });
      return;
    }
    if (wanted.length > MAX_NAME_LEN) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `Keep it to ${MAX_NAME_LEN} characters or fewer — it's a column header.`,
      });
      return;
    }

    // Match case-insensitively against existing members so "hil" and "Hil"
    // don't become two different people.
    const existing = cfg.members.find(
      (p) => p.toLowerCase() === wanted.toLowerCase(),
    );
    const match = existing || wanted;
    const holderId = holderOf(cfg, match);

    if (holderId && holderId !== userId) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text:
          `<b>${esc(match)}</b> is already linked to someone else's account.\n\n` +
          `If that's a mistake, ask them to send <code>/notme</code>, ` +
          `then try <code>/iam ${esc(match)}</code> again.`,
      });
      return;
    }

    const oldName = cfg.people[userId];

    if (oldName === match) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: `You're already linked as <b>${esc(match)}</b>.`,
      });
      return;
    }

    if (!oldName) {
      // First-time link — nothing to overwrite, so no need to confirm.
      cfg.people[userId] = match;
      if (!cfg.members.includes(match)) cfg.members.push(match);
      await putConfig(env, cfg);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: `✅ ${esc(firstName)} is now <b>${esc(match)}</b>.`,
      });
      return;
    }

    // Already linked as a DIFFERENT name. Applying this immediately would
    // leave both names sitting under the same Telegram account (exactly
    // the double-column bug this replaces), so confirm before switching.
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `You're currently linked as <b>${esc(oldName)}</b>. Change to ` +
        `<b>${esc(match)}</b> instead?\n` +
        `<i>${esc(oldName)} will be removed from the board, unless someone ` +
        `else is also using it.</i>`,
      reply_markup: {
        inline_keyboard: [[
          { text: `Yes, I'm ${match}`, callback_data: `iamY:${match}` },
          { text: 'Cancel', callback_data: 'iamN' },
        ]],
      },
    });
    return;
  }

  // Free your own name back up, e.g. so the right person can claim it.
  if (cmd === '/notme') {
    const cfg = await getConfig(env);
    const me = cfg.people[userId];
    if (!me) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'You are not linked to anyone, so there is nothing to unlink.',
      });
      return;
    }
    delete cfg.people[userId];
    await putConfig(env, cfg);
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `Unlinked. <b>${esc(me)}</b> is free for anyone to claim with /iam.`,
    });
    return;
  }

  // Remove a column nobody is using any more (must be unclaimed first).
  if (cmd === '/forget') {
    const wanted = (parts[1] || '').trim();
    const cfg = await getConfig(env);
    if (!wanted) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Usage: /forget NAME — removes someone with no linked account from the board.',
      });
      return;
    }
    const match = cfg.members.find((p) => p.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `No one called ${wanted} is on the board.`,
      });
      return;
    }
    const holderId = holderOf(cfg, match);
    if (holderId) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text:
          `<b>${esc(match)}</b> is still linked to a Telegram account. ` +
          `They should send <code>/notme</code> first, then /forget ${esc(match)} again.`,
      });
      return;
    }
    cfg.members = cfg.members.filter((p) => p !== match);
    await putConfig(env, cfg);
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `<b>${esc(match)}</b> removed from the board.`,
    });
    return;
  }

  if (cmd === '/whoami') {
    const cfg = await getConfig(env);
    const me = cfg.people[userId];
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: me
        ? `You are <b>${esc(me)}</b>.`
        : 'You are not linked yet. Send <code>/iam YourName</code> (pick any name).',
    });
    return;
  }

  if (cmd === '/start' || cmd === '/board' || cmd === '/week') {
    const cfg = await getConfig(env);
    let weekStart = cfg.weekStart || mondayOf(sgtNow());
    // If every meal in that week has passed, roll forward — otherwise the
    // board opens showing a week that has already happened.
    if (!currentMeal(weekStart)) weekStart = nextMondayOf(sgtNow());

    if (!cfg.members.length) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text:
          '<b>Welcome to Home Table</b>\n\n' +
          'It tracks who is eating at home, so nobody has to ask.\n\n' +
          '<b>One-time setup:</b> everyone sends their own name, e.g.\n' +
          '<code>/iam Mum</code>\n\n' +
          'Pick any name — it becomes your column on the board.\n\n' +
          'After that: tap a meal on the board to switch yourself in or out. ' +
          'You can only change your own — nobody can change it for you.',
      });
    } else if (!cfg.people[userId]) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text:
          `On the board: <b>${esc(cfg.members.join(', '))}</b>\n\n` +
          `Not one of those? Link yourself first:\n<code>/iam YourName</code>`,
      });
    }
    await postBoard(env, chatId, weekStart);
    return;
  }

  if (cmd === '/tonight') {
    const cfg = await getConfig(env);
    const weekStart = cfg.weekStart || mondayOf(sgtNow());
    const week = await getWeek(env, weekStart, cfg.members);
    const meal = currentMeal(weekStart);
    if (!meal) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'No meals left this week. Send /nextweek to start the next one.',
      });
      return;
    }
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: renderMeal(week, meal, cfg.members),
      parse_mode: 'HTML',
      reply_markup: mealKeyboard(meal),
    });
    return;
  }

  if (cmd === '/nextweek') {
    await postBoard(env, chatId, nextMondayOf(sgtNow()));
    return;
  }

  // Jump back to the week in progress — e.g. after /nextweek was sent
  // early and the board needs to return to the current, unfinished week.
  if (cmd === '/thisweek') {
    await postBoard(env, chatId, mondayOf(sgtNow()));
    return;
  }

  if (cmd === '/link') {
    const cfg = await getConfig(env);
    if (!cfg.chatId || !cfg.messageId) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'No board yet — send /board first.',
      });
      return;
    }
    const isSupergroup = /^-100/.test(String(cfg.chatId));
    const internal = String(cfg.chatId).replace(/^-100/, '');
    const widgetsOn = !!env.WIDGET_KEY;

    let out = '<b>Home screen setup</b>\n\n';

    // Lead with the widget — it shows today's count without opening
    // anything, instead of an icon that just opens the Telegram chat.
    if (widgetsOn) {
      out +=
        "Best option — a <b>widget</b> that shows today's count at a glance:\n\n" +
        '<b>iPhone</b> — install <i>Scriptable</i> (free, App Store) → <b>+</b> → ' +
        'paste in <code>HomeTableWidget.js</code> → set these two lines:\n' +
        `<code>WORKER_URL = "${esc(origin)}"</code>\n` +
        `<code>WIDGET_KEY = "${esc(env.WIDGET_KEY)}"</code>\n` +
        'Name it <i>Home Table</i> → long-press your home screen → <b>+</b> → ' +
        'Scriptable → small → Add → long-press it → Edit Widget → Script: ' +
        '<i>Home Table</i>.\n\n' +
        '<b>Android</b> — install a JSON widget app (Simple JSON Widget or ' +
        'Data Widget), point it at:\n' +
        `<code>${esc(origin)}/today.json?k=${esc(env.WIDGET_KEY)}</code>\n` +
        'and map <code>focus.count</code> (and <code>focus.in</code> for names).\n\n' +
        '<i>Just want a plain icon instead? See below.</i>\n\n';
    } else {
      out +=
        '<i>Tip: the person who set this up can enable a home-screen ' +
        "widget (today's count, not just an icon) — see the README's " +
        '"Home screen widget" section.</i>\n\n';
    }

    out += '<b>Plain icon (opens the board in Telegram — no live count)</b>\n\n';
    out +=
      '<b>Android</b> — no link needed. Open this group → tap its name → ' +
      '⋮ → <i>Add to home screen</i>.\n\n';
    if (isSupergroup) {
      const native = `tg://privatepost?channel=${internal}&post=${cfg.messageId}`;
      const web = `https://t.me/c/${internal}/${cfg.messageId}`;
      out +=
        '<b>iPhone</b> — Shortcuts app → <b>+</b> → <i>Add Action</i> → search ' +
        `<i>Open URL</i> → paste:\n\n<code>${native}</code>\n\n` +
        'Then tap the <b>dropdown/chevron at the top</b> of the shortcut editor ' +
        '→ <i>Add to Home Screen</i> directly (it also lets you rename it and ' +
        'set its icon there). If your iOS version doesn\'t show that option: ' +
        'tap the shortcut name → rename to <i>Home Table</i> → share icon → ' +
        '<i>Add to Home Screen</i>.\n\n' +
        `Fallback link:\n<code>${web}</code>`;
    } else {
      out +=
        '<b>iPhone</b> — this is still a basic group, so direct message links ' +
        'are unavailable. Use Shortcuts → <i>Open App</i> → Telegram instead, ' +
        'and run /link again once Telegram upgrades the group.';
    }
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: out,
    });
    return;
  }

  if (cmd === '/help') {
    const cfg = await getConfig(env);
    const me = cfg.people[userId];
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        '<b>Home Table</b>\n\n' +
        'Tap a meal on the pinned board to switch <b>yourself</b> in or out. ' +
        'Nobody can change your status for you.\n\n' +
        '/board — show &amp; pin this week\n' +
        '/tonight — the next meal\n' +
        '/nextweek — start next week early\n' +
        '/thisweek — jump back to the week in progress\n' +
        '/iam NAME — link your account (pick your own name)\n' +
        '/whoami — check who you are linked as\n' +
        '/notme — unlink yourself (frees your name for anyone)\n' +
        '/forget NAME — remove someone with no linked account from the board\n' +
        '/link — home screen setup\n\n' +
        `You are: <b>${me ? esc(me) : 'not linked yet'}</b>\n` +
        `On the board: ${cfg.members.length ? esc(cfg.members.join(', ')) : 'nobody yet'}\n` +
        `Legend: ${MARK_IN} eating in &nbsp; ${MARK_UNSET} not indicated &nbsp; ${MARK_OUT} not eating\n` +
        `Change by: ${CUTOFF_HOUR.dinner - 12}pm for dinners, ${CUTOFF_HOUR.lunch}am for lunches`,
    });
  }
}

// ---------------------------------------------------------------- widget feed

async function todayPayload(env) {
  const now = sgtNow();
  const isoToday = now.toISOString().slice(0, 10);
  const thisWeekStart = mondayOf(now);

  const cfg = await getConfig(env);
  const members = cfg.members;

  // The upcoming meal (per WIDGET_CUTOFF_HOUR) may belong to a different
  // week than "today" — e.g. late Sunday night it's already Monday's
  // dinner, which lives in next week's board.
  const up = upcomingWidgetMeal();
  const focusWeekStart = up ? up.weekStart : thisWeekStart;
  const focusMeal = up ? up.meal : null;

  const raw = await env.HOMETABLE.get(`week:${focusWeekStart}`);
  const week = raw ? JSON.parse(raw) : freshWeek(focusWeekStart, members);

  let deepLink = null;
  if (cfg.chatId && cfg.messageId && /^-100/.test(String(cfg.chatId))) {
    const internal = String(cfg.chatId).replace(/^-100/, '');
    deepLink = `tg://privatepost?channel=${internal}&post=${cfg.messageId}`;
  }

  const describe = (m) => {
    if (!m) return null;
    return {
      key: m.key,
      label: mealLabel(m),
      type: m.type,
      cutoff: fmtCutoff(m),
      past: isPastCutoff(focusWeekStart, m),
      count: countIn(week, m.key, members),
      in: namesIn(week, m.key, members),
      out: members.filter((p) => cellState(week, m.key, p) === 'out'),
      unset: members.filter((p) => cellState(week, m.key, p) == null),
    };
  };

  // The "other meal" line in the widget shows the rest of the SAME day as
  // the focus meal (e.g. lunch alongside a Saturday dinner focus) — not
  // necessarily today's date, since focus itself may not be today.
  let sameDayMeals = [];
  if (focusMeal) {
    const focusDateIso = mealDate(focusWeekStart, focusMeal).toISOString().slice(0, 10);
    sameDayMeals = mealsOnDate(focusWeekStart, focusDateIso);
  }

  return {
    date: isoToday,
    weekStart: thisWeekStart,
    focusWeekStart,
    members,
    focus: describe(focusMeal),
    meals: sameDayMeals.map(describe),
    deepLink,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- entry

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Open this URL in any browser to point your bot at this Worker —
    // no terminal/curl needed. Replaces the old "curl the setWebhook URL"
    // step so someone who only deployed via the button never has to touch
    // a command line.
    if (url.pathname === '/setup') {
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return new Response(
          'Set the BOT_TOKEN and WEBHOOK_SECRET secrets first (Cloudflare dashboard → your ' +
          'Worker → Settings → Variables and Secrets), then reload this page.',
          { status: 400 },
        );
      }
      const hookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
      let ok = false;
      let description = '';
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(hookUrl)}`,
        );
        const json = await res.json();
        ok = !!json.ok;
        description = json.description || '';
      } catch (err) {
        description = String(err);
      }
      const html =
        `<!doctype html><meta charset="utf-8"><title>Home Table setup</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;` +
        `padding:0 20px;line-height:1.5;color:#222">` +
        `<h1>${ok ? '✅ Connected!' : '❌ Something went wrong'}</h1>` +
        `<p>${ok
          ? 'Your bot is now linked to this Worker. Go to your Telegram group and send ' +
            '<code>/board</code> to start.'
          : esc(description || 'Check that BOT_TOKEN is set correctly, then reload this page.')
        }</p>` +
        `</body>`;
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/today.json') {
      if (!env.WIDGET_KEY) {
        return new Response('widget feed not enabled', { status: 404 });
      }
      if (url.searchParams.get('k') !== env.WIDGET_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      return new Response(JSON.stringify(await todayPayload(env)), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      });
    }

    if (url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      if (request.method !== 'POST') return new Response('ok');
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad json', { status: 400 });
      }
      try {
        if (update.callback_query) await handleCallback(env, update.callback_query);
        else if (update.message) await handleMessage(env, update.message, url.origin);
      } catch (err) {
        console.log('handler error:', err && err.stack ? err.stack : String(err));
      }
      return new Response('ok');
    }

    return new Response('Home Table bot is running.', { status: 200 });
  },

  // Sunday 02:00 UTC = Sunday 10:00 SGT
  async scheduled(event, env, ctx) {
    const cfg = await getConfig(env);
    if (!cfg.chatId) {
      console.log('no chat configured; send /board in the group first');
      return;
    }
    const weekStart = nextMondayOf(sgtNow());
    await postBoard(env, cfg.chatId, weekStart);
    await tg(env, 'sendMessage', {
      chat_id: cfg.chatId,
      text:
        '☝️ New week is up. Nothing is pre-filled any more — ' +
        'tap in or out for each meal that matters to you.',
    });
  },
};
