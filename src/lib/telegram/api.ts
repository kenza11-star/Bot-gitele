export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed with status ${res.status}`);
}
