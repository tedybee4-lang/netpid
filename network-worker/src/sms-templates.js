// SMS body resolution — the one place an outgoing message is chosen.
//
// Before this module existed, `sms_templates` was written by the seed and the
// admin UI but never read: the worker hardcoded three strings, the expiry sweep
// hardcoded two more, and bulk actions built its own. An operator editing a
// template saw no effect on what subscribers received. Every send path now goes
// through resolveSmsBody() so a stored template actually governs the message.
//
// Delivery status stays honest by construction: this only decides the TEXT. The
// provider call still happens in sms-send, which marks a message sent or failed
// from the real HTTP response — never in advance.

/** Used only when the ISP has no row for that event. */
export const FALLBACKS = {
  payment_received: "Payment received. Receipt available in your portal. Thank you!",
  package_activated: "Your package is now active.",
  welcome: "Welcome! Your account is registered.",
  package_expiring: "Reminder: your package expires soon. Renew via M-Pesa to stay connected.",
  package_expired: "Your package has expired. Renew now to restore service.",
  expiry_reminder: "Your subscription expires soon. Renew to stay online.",
};

/**
 * Substitute {{placeholders}}. An unknown or empty value becomes "" so a
 * customer can never be sent a literal "{{name}}". Unknown tokens are NOT
 * stripped when they do not look like a catalogue key, so a typo shows up in the
 * preview instead of silently disappearing.
 */
export function renderTemplate(body, vars) {
  return String(body).replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** KSh from minor units — matches the dashboard's own formatting. */
export function kes(minor) {
  const n = Number(minor ?? 0) / 100;
  return n.toLocaleString("en-KE", { maximumFractionDigits: 2 });
}

export function dateOnly(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-KE");
}

/**
 * Pick the stored template for an event.
 *
 * Returns `{ disabled: true }` when the ISP turned the template off — the send
 * is skipped rather than silently reverting to the built-in wording, because
 * "I disabled this message" must not mean "you get the default one instead".
 */
export async function resolveSmsBody(sb, { ispId, event, fallback, vars = {} }) {
  const { data, error } = await sb.from("sms_templates")
    .select("locale, body, enabled")
    .eq("isp_id", ispId)
    .eq("event", event)
    .order("locale", { ascending: true })
    .limit(10);
  if (error) {
    // A template read failure must not block the message: fall back to the
    // built-in wording rather than dropping the notification entirely.
    console.error("sms template read failed", error.message);
    return { body: fallback ?? FALLBACKS[event] ?? FALLBACKS.payment_received };
  }

  const rows = data ?? [];
  const pick = rows.find((t) => t.locale === "en") ?? rows[0];
  if (!pick) return { body: fallback ?? FALLBACKS[event] ?? FALLBACKS.payment_received };
  if (pick.enabled === false) return { disabled: true, body: null };
  return { body: renderTemplate(pick.body, vars) };
}
