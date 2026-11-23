import type { ButtonStyle, InlineButton } from "./api";

/** Callback button. */
export const btn = (text: string, data: string, style?: ButtonStyle): InlineButton => ({
  text,
  callback_data: data,
  ...(style ? { style } : {}),
});

/** URL button. */
export const link = (text: string, url: string, style?: ButtonStyle): InlineButton => ({
  text,
  url,
  ...(style ? { style } : {}),
});

/** Red back button used on every screen. */
export const backBtn = (to = "menu:home"): InlineButton => btn("🏠 Kembali", to, "danger");

/** Splits buttons into rows of `size` (default 2 columns). */
export function grid(buttons: InlineButton[], size = 2): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += size) rows.push(buttons.slice(i, i + size));
  return rows;
}

/** [←] [2/3] [→]. Empty when there is only one page. The counter button does nothing. */
export function pager(page: number, pages: number, data: (n: number) => string): InlineButton[][] {
  if (pages <= 1) return [];
  const row: InlineButton[] = [];
  if (page > 0) row.push(btn("←", data(page - 1), "success"));
  row.push(btn(`${page + 1}/${pages}`, "noop", "success"));
  if (page < pages - 1) row.push(btn("→", data(page + 1), "success"));
  return [row];
}

export const repoUrl = (fullName: string): string =>
  `https://github.com/${fullName.split("/").map(encodeURIComponent).join("/")}`;
