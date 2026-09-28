# NETPID Phase 4 acceptance (§§14-18, 25, TESTs 5-7)
- Routers: onboard with encrypted creds (never returned); auto NAS + unique secret once; health job records real online/offline + ROS/model/uptime; test/backup/disconnect via job poll; cross-ISP router read 0 rows
- Sessions: mirror from radacct (15-min window); stale Start closes older open rows; dashboard "online now" from mirror only
- PPPoE/HotSpot: accounts linked customer→radius_user; disconnect removes /ppp/active session
- Portal: public /portal/[slug] shows brand + hotspot/voucher packages only; voucher redeem → login creds + radius-user-sync queued; used/expired codes rejected
- Vouchers: bulk gen (≤5000, unambiguous alphabet, unique per ISP); printable codes view
