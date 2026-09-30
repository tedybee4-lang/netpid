// SMS template catalogue — the single source of truth shared by the template
// editor's preview and the worker's renderer.
//
// WHY THE VARIABLE LIST IS SHORT: every placeholder here is a value the worker
// can actually load when it renders the message (customer row, optional payment
// row, ISP name). Listing `{{balance}}` because it sounds useful would mean the
// renderer silently substituting an empty string into a message the operator
// thought they had tested.

export type TemplateVar = {
  key: string;
  label: string;
  example: string;
  /** Events where the worker can genuinely supply this value. */
  events: string[] | "*";
};

export const TEMPLATE_VARIABLES: TemplateVar[] = [
  { key: "name", label: "Customer name", example: "Jane Wanjiku", events: "*" },
  { key: "customer_no", label: "Account number", example: "C-1042", events: "*" },
  { key: "phone", label: "Phone (254…)", example: "254712345678", events: "*" },
  { key: "isp", label: "Your ISP name", example: "LipaNet", events: "*" },
  { key: "expiry", label: "Package expiry date", example: "31/10/2026", events: "*" },
  { key: "amount", label: "Amount paid (KSh)", example: "1,500", events: ["payment_received"] },
  { key: "receipt", label: "M-Pesa receipt", example: "SGH7XK21YZ", events: ["payment_received"] },
];

export type TemplateEvent = { event: string; label: string; hint: string };

/** Events the queue actually fires. A template for anything else never sends. */
export const TEMPLATE_EVENTS: TemplateEvent[] = [
  { event: "welcome", label: "Welcome", hint: "Sent when a customer account is registered." },
  { event: "payment_received", label: "Payment received", hint: "Sent after a payment is confirmed." },
  { event: "package_activated", label: "Package activated", hint: "Sent when service is switched on." },
  { event: "expiry_reminder", label: "Expiry reminder", hint: "Sent before a package runs out." },
  { event: "suspended", label: "Suspended", hint: "Sent when an account is suspended." },
];

/** Variables usable for a given event, for the editor's insert-palette + preview. */
export function varsFor(event: string): TemplateVar[] {
  return TEMPLATE_VARIABLES.filter((v) => v.events === "*" || v.events.includes(event));
}

/**
 * Substitute `{{key}}` placeholders. Missing values render as an empty string
 * rather than the raw token — a customer must never receive "{{name}}".
 * The `[a-z_]` key set matches what `TEMPLATE_VARIABLES` can ever contain, so
 * unknown tokens are left alone instead of being eaten.
 */
export function renderTemplate(body: string, vars: Record<string, string | number | null | undefined>): string {
  return String(body).replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Keys referenced by a body but not in the catalogue — surfaced in the editor. */
export function unknownVars(body: string, event: string): string[] {
  const known = new Set(varsFor(event).map((v) => v.key));
  const found = new Set<string>();
  for (const m of String(body).matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)) {
    if (!known.has(m[1])) found.add(m[1]);
  }
  return [...found];
}
