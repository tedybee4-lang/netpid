import RouterDefaultsPage from "@/components/RouterDefaultsPage";

export default function PppoeSettingsPage() {
  return (
    <RouterDefaultsPage
      title="PPPoE settings"
      description="The RADIUS and PPPoE values baked into every router's provisioning script. Set them once here and adding a router becomes a matter of typing its name."
      groups={[
        {
          heading: "RADIUS",
          blurb: "Where every router points for authentication and accounting.",
          fields: [
            {
              key: "radius_server", label: "RADIUS server address", placeholder: "10.10.10.254",
              hint: "The FreeRADIUS host on your management network.",
            },
            { key: "radius_auth_port", label: "Auth port", kind: "number" },
            { key: "radius_acct_port", label: "Accounting port", kind: "number" },
            {
              key: "radius_coa_port", label: "CoA port", kind: "number",
              hint: "Lets NETPID disconnect a user from the dashboard.",
            },
            {
              key: "nas_prefix", label: "NAS name prefix",
              hint: "A router named Kawangware registers as netpid-kawangware.",
            },
          ],
        },
        {
          heading: "Router management",
          blurb: "New routers get the next free address in this subnet, and these API credentials.",
          fields: [
            { key: "mgmt_subnet", label: "Management subnet", hint: "e.g. 10.10.10.0/24" },
            { key: "mgmt_gateway", label: "Gateway" },
            { key: "api_username", label: "API user" },
            { key: "api_port", label: "API port", kind: "number" },
            { key: "api_ssl_port", label: "API SSL port", kind: "number" },
            { key: "use_ssl", label: "Connect to the router API over TLS", kind: "check" },
            {
              key: "ros_version", label: "Default RouterOS version", kind: "select",
              options: [["7", "RouterOS 7 (/interface wifi)"], ["6", "RouterOS 6 (/interface wireless)"]],
              hint: "Both scripts are always generated; this decides which opens first.",
            },
          ],
        },
      ]}
    />
  );
}
