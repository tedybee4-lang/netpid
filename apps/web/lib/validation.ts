import { z } from "zod";

export const createIspSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, hyphens"),
  phone: z.string().min(7).max(20).optional(),
  email: z.string().email().optional().or(z.literal("")),
  location: z.string().max(200).optional(),
  planSlug: z.string().default("starter"),
});

export type CreateIspInput = z.infer<typeof createIspSchema>;

export const createPackageSchema = z.object({
  name: z.string().min(2).max(120),
  service_type: z.enum(["pppoe", "hotspot", "voucher", "static"]),
  price: z.number().int().min(0), // minor units (KES cents)
  duration_value: z.number().int().min(1).default(30),
  duration_unit: z.enum(["hours", "days", "weeks", "months"]).default("days"),
  download_kbps: z.number().int().positive().nullable().optional(),
  upload_kbps: z.number().int().positive().nullable().optional(),
  data_cap_mb: z.number().int().positive().nullable().optional(),
  session_timeout: z.number().int().positive().nullable().optional(),
  idle_timeout: z.number().int().positive().nullable().optional(),
  simultaneous_users: z.number().int().min(1).default(1),
  ip_pool: z.string().max(64).nullable().optional(),
  enabled: z.boolean().default(true),
});

export const createCustomerSchema = z.object({
  full_name: z.string().min(2).max(160),
  phone: z.string().min(7).max(20),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().max(300).optional().or(z.literal("")),
  service_type: z.enum(["pppoe", "hotspot", "voucher", "static"]).default("pppoe"),
  package_id: z.string().uuid().nullable().optional(),
  username: z.string().min(2).max(64).nullable().optional(),
  notes: z.string().max(1000).optional().or(z.literal("")),
});

export const initiatePaymentSchema = z.object({
  customer_id: z.string().uuid(),
  package_id: z.string().uuid().nullable().optional(),
  amount: z.number().int().positive(),
  phone: z.string().min(7).max(20),
});

export const createRouterSchema = z.object({
  name: z.string().min(2).max(120),
  host: z.string().ip(),
  api_port: z.number().int().min(1).max(65535).default(8728),
  api_ssl_port: z.number().int().min(1).max(65535).default(8729),
  api_username: z.string().min(1).max(64).default("netpid"),
  api_password: z.string().min(1).max(256),
  use_ssl: z.boolean().default(true),
  // auto-provision a RADIUS NAS client for this router (unique secret shown once)
  nas: z.boolean().default(true),
  nas_shortname: z.string().min(2).max(64).optional(),
  // FreeRADIUS endpoint, baked into the generated RouterOS script only
  radius_server: z.string().min(1).max(120).optional(),
  site: z.string().max(120).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  // Optional PPPoE/HotSpot profiles to render as rate-limited lines in the script
  profiles: z.array(z.object({
    name: z.string().min(1).max(64),
    kind: z.enum(["pppoe", "hotspot"]).optional(),
    pool: z.string().max(64).optional(),
    download_kbps: z.number().int().nonnegative().optional(),
    upload_kbps: z.number().int().nonnegative().optional(),
  })).max(20).optional(),
});

// Per-customer speed cap. Both fields are independent: a customer can be
// 20 Mbps down / 5 Mbps up, or only one of the two. Omitting BOTH clears the
// override and hands the customer back to their package's group.
export const updateCustomerSpeedSchema = z.object({
  download_mbps: z.number().min(0).max(100000).nullable().optional(),
  upload_mbps: z.number().min(0).max(100000).nullable().optional(),
}).refine(
  (v) => v.download_mbps !== undefined || v.upload_mbps !== undefined,
  { message: "Provide download_mbps and/or upload_mbps" },
);

export const voucherBatchSchema = z.object({
  name: z.string().min(2).max(120),
  package_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(5000),
  code_length: z.number().int().min(6).max(16).default(8),
  expires_at: z.string().datetime().nullable().optional(),
});

export const voucherRedeemSchema = z.object({
  code: z.string().min(4).max(32),
  mac: z.string().max(32).optional(),
});

export const smsSettingsSchema = z.object({
  sender_id: z.string().max(11).optional().or(z.literal("")),
  daily_limit: z.number().int().min(0).max(100000),
  monthly_limit: z.number().int().min(0).max(1000000),
  enabled: z.boolean(),
});


