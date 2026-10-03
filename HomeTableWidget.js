// Home Table — iOS home screen widget
// Runs in the Scriptable app (free, App Store).
//
// SETUP: replace the two values below, then run once inside Scriptable
// to check it works. Then add a Scriptable widget to your home screen
// and set its script to this one.

const WORKER_URL = "https://hometable-bot.groupmeals.workers.dev";
const WIDGET_KEY = "PASTE_YOUR_WIDGET_KEY_HERE";

// ----------------------------------------------------------------- theme

const BG_TOP = new Color("#227C66");
const BG_BOTTOM = new Color("#124E44");
const CREAM = new Color("#F8F4EA");
const DIM = new Color("#F8F4EA", 0.55);

// ----------------------------------------------------------------- fetch

async function load() {
  const req = new Request(
    `${WORKER_URL}/today.json?k=${encodeURIComponent(WIDGET_KEY)}`
  );
  req.timeoutInterval = 10;
  return await req.loadJSON();
}

// ----------------------------------------------------------------- build

function gradient() {
  const g = new LinearGradient();
  g.colors = [BG_TOP, BG_BOTTOM];
  g.locations = [0, 1];
  return g;
}

function buildWidget(data) {
  const w = new ListWidget();
  w.backgroundGradient = gradient();
  w.setPadding(14, 14, 14, 14);

  // Tapping anywhere opens the board in Telegram.
  if (data.deepLink) w.url = data.deepLink;

  const focus = data.focus;

  if (!focus) {
    const t = w.addText("No meals today");
    t.font = Font.mediumSystemFont(15);
    t.textColor = CREAM;
    return w;
  }

  // Header line: which meal, and the cut-off
  const head = w.addStack();
  head.centerAlignContent();

  const label = head.addText(focus.label.toUpperCase());
  label.font = Font.semiboldSystemFont(11);
  label.textColor = DIM;

  head.addSpacer();

  const cut = head.addText(focus.past ? "closed" : `by ${focus.cutoff}`);
  cut.font = Font.mediumSystemFont(11);
  cut.textColor = DIM;

  w.addSpacer(8);

  // The number — the thing you read from across the room
  const big = w.addStack();
  big.centerAlignContent();

  const n = big.addText(String(focus.count));
  n.font = Font.boldSystemFont(34);
  n.textColor = CREAM;

  big.addSpacer(6);

  const word = big.addText(focus.count === 1 ? "eating\nin" : "eating\nin");
  word.font = Font.mediumSystemFont(12);
  word.textColor = DIM;

  big.addSpacer();

  // Edit affordance — the whole widget is tappable, this just signals it
  const pencil = big.addStack();
  pencil.setPadding(5, 7, 5, 7);
  pencil.cornerRadius = 8;
  pencil.backgroundColor = new Color("#F8F4EA", 0.16);
  const pen = pencil.addText("edit");
  pen.font = Font.semiboldSystemFont(11);
  pen.textColor = CREAM;
  if (data.deepLink) pencil.url = data.deepLink;

  w.addSpacer(8);

  // Who's in
  const inRow = w.addText(focus.in.length ? focus.in.join("  ") : "nobody");
  inRow.font = Font.semiboldSystemFont(14);
  inRow.textColor = CREAM;
  inRow.lineLimit = 1;

  // Who's out, quieter
  if (focus.out.length) {
    const outRow = w.addText(`out: ${focus.out.join(", ")}`);
    outRow.font = Font.systemFont(11);
    outRow.textColor = DIM;
    outRow.lineLimit = 1;
  }

  w.addSpacer();

  // Second meal today (weekend lunch + dinner)
  const other = data.meals.filter((m) => m.key !== focus.key);
  if (other.length) {
    const o = other[0];
    const line = w.addText(`${o.label}: ${o.count} in`);
    line.font = Font.systemFont(10);
    line.textColor = DIM;
  }

  return w;
}

function errorWidget(message) {
  const w = new ListWidget();
  w.backgroundGradient = gradient();
  w.setPadding(14, 14, 14, 14);
  const t = w.addText("Home Table");
  t.font = Font.semiboldSystemFont(13);
  t.textColor = CREAM;
  w.addSpacer(4);
  const e = w.addText(message);
  e.font = Font.systemFont(11);
  e.textColor = DIM;
  return w;
}

// ----------------------------------------------------------------- run

let widget;
try {
  const data = await load();
  widget = buildWidget(data);
} catch (err) {
  widget = errorWidget(String(err).slice(0, 120));
}

// Ask iOS to refresh in ~30 min. iOS decides the real timing.
widget.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentSmall();
}
Script.complete();
