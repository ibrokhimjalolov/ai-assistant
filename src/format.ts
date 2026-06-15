// The agent is instructed (see TELEGRAM_OUTPUT_INSTRUCTION in src/claude.ts) to
// emit Telegram-flavored HTML directly, and GrammyTelegramApi sends with
// parse_mode: 'HTML'. This module holds the two HTML helpers the runtime itself
// needs — it does NOT rewrite the model's output:
//   - escapeHtml: makes the runtime's own dynamic text (error details, tool
//     input in approval prompts) safe to embed in an HTML message.
//   - htmlToPlain: the delivery fallback used only when Telegram rejects a
//     message's entities, so the user still gets readable text, never nothing.

/** Escape the three characters Telegram's HTML parser treats as markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Strip HTML tags and unescape entities — plain-text delivery fallback. */
export function htmlToPlain(html: string): string {
  if (!html) return html;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|blockquote|pre|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trimEnd();
}
