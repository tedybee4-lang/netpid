// NETPID pricing — single source of truth for the marketing site, the pricing
// page and the onboarding plan picker. Amounts are MINOR UNITS (KES cents).
//
// The model is usage-based rather than fixed tiers: a monthly fee per MikroTik
// router, capped, plus per-subscriber rates. The tiers below are simply the
// router counts ISPs typically run at, and the seeded netpid_plans rows carry
// these same numbers (see supabase/seed.sql + migration 0035).
export const RATES = {
  perRouter: 50_000,      // KSh 500 per router / month
  routerFeeCap: 299_900,  // ...but the router fee never exceeds KSh 2,999
  perPppoeSub: 2_000,     // KSh 20 per PPPoE subscriber / month
  perStaticSub: 2_500,    // KSh 25 per static subscriber / month
  perSms: 75,             // KSh 0.75 per SMS
  installFee: 100_000,    // KSh 1,000 one-time, optional
} as const;

export const TRIAL_DAYS = 3;

export interface Tier {
  slug: string;
  name: string;
  routers: number;          // -1 = unlimited
  priceMonthly: number;     // -1 = custom / talk to us
  priceYearly: number;
  tagline: string;
  blurb: string;
  features: string[];
  popular?: boolean;
  custom?: boolean;
}

export const TIERS: Tier[] = [
  {
    slug: "starter-pilot",
    name: "Starter Pilot",
    routers: 1,
    priceMonthly: 50_000,
    priceYearly: 600_000,
    tagline: "1 hotspot",
    blurb: "Small shop, salon or café getting its first automated hotspot.",
    features: [
      "1 MikroTik router, provisioned in minutes",
      "M-Pesa STK Push hotspot sales",
      "Branded captive portal",
      "Vouchers and packages",
      "Live revenue and session dashboard",
      "Email + WhatsApp support",
    ],
  },
  {
    slug: "growth-isp",
    name: "Growth ISP",
    routers: 3,
    priceMonthly: 150_000,
    priceYearly: 1_800_000,
    tagline: "Up to 3 routers",
    blurb: "A growing ISP running several sites with staff and resellers.",
    popular: true,
    features: [
      "Everything in Starter Pilot",
      "Up to 3 MikroTik routers",
      "PPPoE + HotSpot + voucher billing",
      "Up to 5 staff with role-based access",
      "Reseller and field-agent accounts",
      "FreeRADIUS sessions, vouchers and reports",
      "Guided onboarding documentation",
    ],
  },
  {
    slug: "scaled-isp",
    name: "Scaled ISP",
    routers: 10,
    priceMonthly: 299_900,
    priceYearly: 3_598_800,
    tagline: "10+ routers",
    blurb: "Multi-site operations where the router fee is already capped.",
    features: [
      "Everything in Growth ISP",
      "Up to 10 routers — fee capped, never rises",
      "Free router-config call with our team",
      "Up to 15 staff, 50 resellers",
      "Inventory, expenses and advanced reports",
      "Topology, diagnostics and TR-069",
    ],
  },
  {
    slug: "white-label",
    name: "White-Label",
    routers: -1,
    priceMonthly: -1,
    priceYearly: -1,
    tagline: "Custom",
    blurb: "Perpetual licence or an on-premise deployment for your business.",
    custom: true,
    features: [
      "Perpetual licensing",
      "On-premise deployment",
      "Custom integrations",
      "White-label branding",
      "Dedicated account manager",
      "SLA guarantee and 24/7 phone support",
    ],
  },
];

/** Router fee for N routers, applying the cap. */
export function routerFee(routers: number): number {
  if (routers <= 0) return 0;
  return Math.min(routers * RATES.perRouter, RATES.routerFeeCap);
}

/** Full monthly estimate: capped router fee + per-subscriber charges. */
export function monthlyEstimate(routers: number, pppoe = 0, staticSubs = 0): number {
  return routerFee(routers) + pppoe * RATES.perPppoeSub + staticSubs * RATES.perStaticSub;
}

export const PLAN_SLUGS = TIERS.filter((t) => !t.custom).map((t) => t.slug);
export const DEFAULT_PLAN_SLUG = "starter-pilot";
