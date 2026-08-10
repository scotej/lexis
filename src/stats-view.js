import { buildStats } from "./core/stats.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(date, options = { day: "numeric", month: "short" }) {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-AU", options);
}

function metric(label, value, note) {
  const card = el("div", "stats-metric");
  card.append(el("span", "stats-metric-label", label), el("strong", "stats-metric-value", value));
  if (note) card.append(el("span", "stats-metric-note", note));
  return card;
}

function chart(title, total, points, key, noun, className = "") {
  const section = el("section", `stats-chart-card ${className}`.trim());
  const head = el("div", "stats-chart-head");
  head.append(el("h2", "stats-chart-title", title), el("span", "stats-chart-total", total));
  section.append(head);

  const values = points.map((point) => point[key]);
  const max = Math.max(1, ...values);
  const bars = el("div", "stats-chart");
  bars.style.gridTemplateColumns = `repeat(${points.length}, minmax(2px, 1fr))`;
  bars.setAttribute("aria-label", `${title}, daily over the last ${points.length} days`);

  points.forEach((point) => {
    const value = point[key];
    const bar = el("span", "stats-bar");
    const fill = el("span", "stats-bar-fill");
    if (value > 0) {
      fill.style.height = `${Math.max(5, (value / max) * 100)}%`;
      bar.tabIndex = 0;
      bar.setAttribute(
        "aria-label",
        `${formatDate(point.date, { weekday: "short", day: "numeric", month: "short" })}: ${value} ${noun}${value === 1 ? "" : "s"}`
      );
      bar.title = bar.getAttribute("aria-label");
    } else {
      fill.style.height = "0";
      bar.setAttribute("aria-hidden", "true");
    }
    bar.append(fill);
    bars.append(bar);
  });

  const axis = el("div", "stats-chart-axis");
  axis.append(el("span", null, formatDate(points[0].date)), el("span", null, formatDate(points.at(-1).date)));
  section.append(bars, axis);
  return section;
}

export function installStatsView() {
  if (document.getElementById("view-stats")) return;

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "stats.css";
  style.dataset.lexisStats = "";
  document.head.append(style);

  const button = el("button", "rail-link", "stats");
  button.dataset.view = "stats";
  const links = document.querySelector(".rail-links");
  const essayLink = links.querySelector('[data-view="essay"]');
  links.insertBefore(button, essayLink);

  const view = el("section", "view");
  view.id = "view-stats";
  const essayView = document.getElementById("view-essay");
  essayView.parentNode.insertBefore(view, essayView);
}

export function renderStatsView(bank) {
  const view = document.getElementById("view-stats");
  if (!view) return;

  const stats = buildStats(bank);
  view.replaceChildren();

  const head = el("header", "view-head");
  head.append(
    el("p", "eyebrow", "statistics"),
    el(
      "p",
      "lede",
      `Your current bank over the last ${stats.days} days, from ${formatDate(stats.start)} to ${formatDate(stats.end)}.`
    )
  );

  const metrics = el("div", "stats-metrics");
  metrics.append(
    metric("bank", String(stats.totals.words), "words"),
    metric("reviews", String(stats.totals.reviews), "recorded"),
    metric("streak", String(stats.totals.streak), stats.totals.streak === 1 ? "day" : "days"),
    metric("essay uses", String(stats.totals.essay_uses), "logged")
  );

  const charts = el("div", "stats-charts");
  charts.append(
    chart(
      "words added",
      `${stats.window.added} in ${stats.days}d`,
      stats.daily,
      "added",
      "word",
      "stats-chart-added"
    ),
    chart(
      "reviews",
      `${stats.window.reviews} in ${stats.days}d`,
      stats.daily,
      "reviews",
      "review",
      "stats-chart-reviews"
    )
  );

  view.append(head, metrics, charts);

  if (stats.history.limited) {
    view.append(
      el(
        "p",
        "stats-note",
        "Older bank data did not store every review event, so pre-update history can only recover each word’s latest known review. Removed words are not included."
      )
    );
  } else {
    view.append(el("p", "stats-note", "Removed words are not included in these statistics."));
  }
}
