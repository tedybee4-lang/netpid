import RouterDefaultsPage from "@/components/RouterDefaultsPage";

export default function HotspotSettingsPage() {
  return (
    <RouterDefaultsPage
      title="HotSpot settings"
      description="Defaults applied to HotSpot-capable routers. Kept separate from PPPoE so an operator can tune each service without touching the other."
      groups={[
        {
          heading: "Wi-Fi AP",
          blurb: "Left blank, the generated script does not touch the radio at all — bridging is the operator's call, not a guess.",
          fields: [
            {
              key: "wifi_ssid", label: "Default SSID",
              hint: "A router named Kawangware publishes this name. Leave blank to skip the radio entirely.",
            },
            {
              key: "country_code", label: "Country code",
              hint: "Applied as the wireless country so the radio obeys local power limits. Kenya = ke.",
            },
          ],
        },
        {
          heading: "Shared infrastructure",
          blurb: "These same values are used by the PPPoE side, so both services stay consistent.",
          fields: [
            {
              key: "dns_servers", label: "DNS servers",
              hint: "A captive portal must resolve before the login page can load.",
            },
            {
              key: "ntp_servers", label: "NTP servers",
              hint: "An unset clock breaks RADIUS accounting — Acct-Stop timestamps must be sane.",
            },
            { key: "radius_server", label: "RADIUS server address", placeholder: "10.10.10.254" },
            { key: "radius_auth_port", label: "Auth port", kind: "number" },
            { key: "radius_acct_port", label: "Accounting port", kind: "number" },
          ],
        },
      ]}
    />
  );
}
