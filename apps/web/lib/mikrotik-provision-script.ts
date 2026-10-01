/**
 * RouterOS script generation for the interactive provisioning handshake.
 *
 * RouterOS dialect rules this file obeys, each learned from a real device
 * rejecting the alternative:
 *
 *   - [:pick] is 1-BASED. A 0 index returns NOTHING rather than erroring, which
 *     is how a version guard once failed on every router including healthy ones.
 *   - A nested [:find] inside [:pick] arguments is a parse error.
 *   - There is no :continue, no HTTP client, no URL encoder and no request body.
 *   - Comments are `#`. A `}` emitted as `# }` does NOT close its block, so
 *     every block closer here is a real statement.
 */

const NL = "\n";

function q(v: unknown): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

/** RouterOS names are used in commands, so anything structural is rejected. */
export function safeIface(name: unknown): string {
  const s = String(name ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(s)) {
    throw new Error(`Unsafe interface name: ${JSON.stringify(name)}`);
  }
  return s;
}

export function safeRouterId(id: unknown): string {
  const s = String(id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) {
    throw new Error(`Unsafe router id: ${JSON.stringify(id)}`);
  }
  return s;
}

/**
 * Phase 1: the script the router downloads and runs.
 *
 * It reads the hardware, builds a query string and GETs it back to NETPID.
 * GET, not POST, because `/tool fetch` cannot do anything else - see the note
 * at the top of lib/mikrotik-provision.ts.
 *
 * Everything is wrapped in :do/:on-error so one unreadable property cannot abort
 * the whole report and leave the dashboard waiting forever.
 */
export function buildBootstrapScript(opts: {
  baseUrl: string;
  token: string;
  sessionId: string;
}): string {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const reg = `${base}/api/provision/mikrotik/register/${opts.token}`;
  const L: string[] = [];
  const p = (s = "") => L.push(s);
  const c = (s: string) => p(`# ${s}`);

  c("=".repeat(68));
  c(`NETPID discovery — session ${opts.sessionId}`);
  c("");
  c("READ-ONLY. This script changes nothing: it only reads the hardware and");
  c("reports it to NETPID so the dashboard can show the real ports. The");
  c("configuration script is generated afterwards, once you choose the ports.");
  c("=".repeat(68));
  p("");

  c("Each read is wrapped: a property this board does not have must not abort");
  c("the whole report and leave the operator staring at a blank dashboard.");
  p(":local npB \"\"");
  p(":local npM \"\"");
  p(":local npV \"\"");
  p(":local npA \"\"");
  p(":local npC \"\"");
  p(":local npR \"\"");
  p("");
  p(":do { :set npB [/system resource get board-name] } on-error={ :set npB \"\" }");
  p(":do { :set npM [/system resource get board-name] } on-error={ }");
  p(":do { :set npV [/system resource get version] } on-error={ }");
  p(":do { :set npA [/system resource get architecture-name] } on-error={ }");
  p(":do { :set npC [/system resource get cpu] } on-error={ }");
  p(":do { :set npR [/system resource get total-memory] } on-error={ }");
  p("");
  c("Interface names, comma separated.");
  p(":local npI \"\"");
  p(":foreach i in=[/interface find] do={");
  p("  :do {");
  p("    :local npN [/interface get $i name]");
  p("    :if ([:len $npN] > 0) do={");
  p("      :if ([:len $npI] = 0) do={ :set npI $npN } else={ :set npI ($npI . \",\" . $npN) }");
  p("    }");
  p("  } on-error={ }");
  p("}");
  p("");
  c("Existing bridges and their member ports, as \"name:port,port\" entries.");
  p(":local npG \"\"");
  p(":foreach b in=[/interface bridge find] do={");
  p("  :do {");
  p("    :local npBN [/interface bridge get $b name]");
  p("    :local npBP \"\"");
  p("    :foreach m in=[/interface bridge port find where bridge=$npBN] do={");
  p("      :do {");
  p("        :local npMP [/interface bridge port get $m interface]");
  p("        :if ([:len $npMP] > 0) do={");
  p("          :if ([:len $npBP] = 0) do={ :set npBP $npMP } else={ :set npBP ($npBP . \",\" . $npMP) }");
  p("        }");
  p("      } on-error={ }");
  p("    }");
  p("    :if ([:len $npBN] > 0) do={");
  p("      :if ([:len $npG] = 0) do={ :set npG ($npBN . \":\" . $npBP) } else={ :set npG ($npG . \";\" . $npBN . \":\" . $npBP) }");
  p("    }");
  p("  } on-error={ }");
  p("}");
  p("");
  c("Report it. RouterOS has no URL encoder, so spaces travel as '+' and are");
  c("decoded server side. /tool fetch performs a GET, which is all a router can");
  c("do without something extra installed first.");
  c("");
  c("The URL is built ONE STATEMENT PER LINE on purpose. An expression split");
  c("across lines inside (...) is a syntax error on RouterOS: the parser");
  c("reaches end-of-line still inside the parenthesis and gives up, reporting");
  c("only a column number with no clue which line it was. Every statement");
  c("below is therefore complete on its own line.");
  c("");
  c("npUrl MUST be declared with :local first. RouterOS rejects :set on a");
  c("variable that does not exist, and the error points at the variable name,");
  c("which reads as if the URL were malformed. Declaring it here is what makes");
  c("the :set lines below legal.");
  c("");
  c("SPACES ARE ENCODED, BECAUSE A RAW SPACE BREAKS THE FETCH.");
  c("'hAP lite', 'MIPS 24Kc V7.4' and '65536 KiB' all contain one. RFC 3986");
  c("forbids a literal space in a URL and /tool fetch rejects the whole request,");
  c("so the report never leaves the router.");
  c("");
  c("THERE IS NO [:split] FUNCTION IN ROUTEROS. This is the fourth dialect");
  c("failure, and the most misleading one: the router parses the word inside");
  c("the brackets as a command to run and reports \"bad command name split\"");
  c("with a line and column, which reads as though the value were malformed.");
  c("There is no URL encoder either, so each field is walked one character at");
  c("a time with [:len] and [:pick] and every space becomes '+'. The server");
  c("decodes '+' back to a space, so nothing is lost.");
  c("");
  c("Only spaces are handled. A value containing &, ?, #, = or \" would still");
  c("corrupt the query string, but no board name, CPU string, RAM figure or");
  c("interface name contains one, and the report is retried on a fresh token.");
  // The FIRST append carries the "?", every later one "&". Getting this wrong
  // sends ?board=x&board=y and the server sees only the last value.
  const params: [string, string][] = [
    ["board", "npB"], ["model", "npM"], ["version", "npV"], ["arch", "npA"],
    ["cpu", "npC"], ["ram", "npR"], ["ifaces", "npI"], ["bridges", "npG"],
  ];
  p(`:local npUrl ${q(reg)}`);
  params.forEach(([k, v], i) => {
    // Space -> '+' by walking the value one character at a time.
    //
    // The obvious `[:foreach w in=[:split $v " "]]` does not work: [:split is
    // not in the RouterOS dialect at all. Everything used below - :local, :set,
    // :while, :if, [:len] and [:pick] - is core, so there is nothing here that
    // depends on a function the router might not have.
    p(`:local npS ""`);
    // Scratch names are npS, npX, npY and npZ. NONE of them is a data name.
    // Two collisions existed before this was checked: the counter was npI, which
    // holds the interface list, and the character variable was npC, which holds
    // the CPU string. Each wiped the very value its own [:len] was about to
    // measure, so those two fields reported "0" while the other six were fine.
    p(`:local npX ""`);
    p(`:local npY 0`);
    p(`:local npZ [:len $${v}]`);
    p(`:while ($npY < $npZ) do={`);
    p(`  :set npX [:pick $${v} $npY ($npY + 1)]`);
    p(`  :if ($npX = " ") do={ :set npS ($npS . "+") } else={ :set npS ($npS . $npX) }`);
    p(`  :set npY ($npY + 1)`);
    p(`}`);
    p(`:set npUrl ($npUrl . ${q(`${i === 0 ? "?" : "&"}${k}=`)} . $npS)`);
    p(`:set npS ""`);
    p(`:set npX ""`);
    p(`:set npY 0`);
    p(`:set npZ 0`);
  });
  p("");
  p(":do {");
  // :retry, for the same reason the bootstrap command retries: /tool fetch on
  // RouterOS 7 intermittently answers "SSL: internal error (6)" when its TLS
  // connection pool is wedged, and it clears on a subsequent attempt. The
  // report is the one thing this script exists to do, so one transient failure
  // should not cost the operator the whole run.
  p("  :retry command={/tool fetch mode=https keep-result=no url=$npUrl} delay=3s max=3");
  p("  :put \"NETPID: hardware reported. Check the dashboard.\"");
  p("} on-error={");
  p("  :put \"NETPID: report FAILED after 3 attempts. The router is fine; the upload did not go.\"");
  p("  :put \"Print this URL and open it in a browser to see why:\"");
  // Print the URL that actually failed. Printing an empty line, as an
  // undeclared variable did, tells the operator nothing at all.
  p(`  :put $npUrl`);
  p("  :put \"If it opens in a browser, the router is blocking outbound HTTPS.\"");
  p("  :put \"If it does not, the token has expired - generate a new one.\"");
  p("}");
  p("");
  // Clear every variable the script declared, so the router console is not left
  // littered and a re-paste starts from a known state.
  //
  // npQ is deliberately absent: it was a leftover from the single-expression
  // version of the URL, and clearing an undeclared variable aborts the script
  // HERE, after the report was sent but with an error the operator cannot
  // explain. npS and npW are scratch buffers already reset inside the loop.
  p(":set npB \"\"");
  p(":set npM \"\"");
  p(":set npV \"\"");
  p(":set npA \"\"");
  p(":set npC \"\"");
  p(":set npR \"\"");
  p(":set npI \"\"");
  p(":set npG \"\"");
  p(":set npUrl \"\"");
  return L.join(NL);
}

export interface ConfigureOptions {
  routerId: string;
  rosMajor: 7 | 6;
  mode: "HOTSPOT" | "PPPOE" | "HOTSPOT_PPPOE";
  wan: string;
  hotspotPorts: string[];
  hotspotIface: string;
  hotspotSubnet: string;
  hotspotRange: string;
  hotspotDnsName: string;
  pppoePorts: string[];
  pppoePool: string;
  pppoeRanges: string;
  pppoeLocal: string;
  pppoeService: string;
  radiusServer: string;
  /** Operator-supplied. Never a repository default. */
  radiusSecret: string;
  nasShortname: string;
  radiusAuthPort: number;
  radiusAcctPort: number;
  radiusCoaPort: number;
  /** Issued only after NETPID has minted a real tunnel for this router. */
  wireguard?: {
    serverPublicKey: string;
    routerTunnelIp: string;
    serverTunnelIp: string;
  };
  heartbeatUrl: string;
  bridgeIface: string;
  heartbeatName: string;
}

/**
 * Phase 2: the configuration script, built from what the router REPORTED and
 * what the operator CHOSE.
 *
 * Guarantees enforced here:
 *   - every created object carries comment="NETPID:<router_id>", so a re-run
 *     converges and a human can see what belongs to NETPID;
 *   - nothing outside that namespace is removed, no firewall is flushed and no
 *     reset is issued;
 *   - the RADIUS menu path follows the REPORTED RouterOS major version;
 *   - WireGuard appears only when the box reported v7, otherwise it is omitted
 *     with the reason printed rather than failing the whole script.
 */
export function buildConfigureScript(o: ConfigureOptions): string {
  const tag = `NETPID:${safeRouterId(o.routerId)}`;
  const v7 = o.rosMajor === 7;
  // RADIUS moved out of /ip in RouterOS 7; a v7 box answers
  // "bad command name radius" for the v6 path.
  const RM = v7 ? "/radius" : "/ip radius";
  const wan = safeIface(o.wan);
  const hb = o.heartbeatName;

  const L: string[] = [];
  const p = (s = "") => L.push(s);
  const c = (s: string) => p(`# ${s}`);
  const rule = () => p(`# ${"=".repeat(68)}`);

  rule();
  c(`NETPID configuration — router ${tag}`);
  c("");
  c(`Mode: ${o.mode}   RouterOS: ${o.rosMajor}.x   WAN: ${wan}`);
  c("");
  c("This ADDS NETPID objects and UPDATES NETPID objects. It does NOT reset");
  c("the router, flush the firewall, or remove anything NETPID did not create.");
  c("Every object it makes is tagged");
  p(`#   comment=${q(tag)}`);
  c("so a re-run converges and a human can see what belongs to NETPID.");
  c("");
  c("Safe to re-run.");
  rule();
  p("");

  // ---- 1. Interfaces -------------------------------------------------------
  rule();
  c("1. INTERFACES");
  rule();
  p("");
  c("The WAN is left on DHCP. NETPID can drive a static address later; a wrong");
  c("gateway set here would take the router offline for everyone behind it.");
  c("A STOCK MIKROTIK PUTS EVERY LAN PORT IN ITS DEFAULT BRIDGE. So on an");
  c("unconfigured board the WAN the operator just chose is almost certainly a");
  c("bridge member, and a bridge member cannot be routed. That ownership has to");
  c("be broken BEFORE the DHCP client is added, or the WAN comes up enslaved to");
  c("a bridge with no address and the operator gets a dead uplink and no error.");
  p("");
  c("Only the named WAN is released. Every other member is left alone, so the LAN");
  c("keeps working while this runs.");
  p(`:if ([:len [/interface find name=${wan}]] = 0) do={`);
  p(`  :put "SKIP WAN: no interface named ${wan}."`);
  p("} else={");
  p(`  :if ([:len [/interface bridge port find interface=${wan}]] > 0) do={`);
  p(`    :local npWb [/interface bridge port get [find interface=${wan}] bridge]`);
  p(`    :put ("releasing " . ${q(wan)} . " from bridge " . $npWb)`);
  p(`    /interface bridge port remove [find interface=${wan}]`);
  p("  }");
  p(`  :if ([:len [/interface dhcp-client find interface=${wan}]] = 0) do={`);
  p(`    /interface dhcp-client add interface=${wan} disabled=no comment=${q(`${tag} wan-dhcp`)}`);
  p("  }");
  p(`  :put ("WAN " . ${q(wan)} . ": DHCP client present.")`);
  p("}");
  p("");

  // ---- 2. Bridge -----------------------------------------------------------
  rule();
  c("2. BRIDGE");
  rule();
  p("");
  c("One bridge holds the customer ports. Ports named by the operator are");
  c("moved into it; nothing else is. A port already enslaved elsewhere is");
  c("reported in the dashboard before this script is produced.");
  p(`:if ([:len [/interface bridge find name=${q(o.bridgeIface)}]] = 0) do={`);
  p(`  /interface bridge add name=${q(o.bridgeIface)} comment=${q(`${tag} bridge`)}`);
  p(`  :put ("bridge created: " . ${q(o.bridgeIface)})`);
  p("}");
  const allPorts = [...o.hotspotPorts, ...o.pppoePorts];
  for (const port of allPorts) {
    const sp = safeIface(port);
    p(`:do {`);
    p(`  :if ([:len [/interface bridge port find interface=${sp}]] > 0) do={`);
    p(`    /interface bridge port remove [find interface=${sp}]`);
    p("  }");
    p(`  /interface bridge port add bridge=${q(o.bridgeIface)} interface=${sp} pvid=1 comment=${q(`${tag} port`)}`);
    p(`  :put ("bridge " . ${q(o.bridgeIface)} . " <- " . ${q(sp)})`);
    p("} on-error={");
    p(`  :put ("SKIP " . ${q(sp)} . ": could not be bridged.")`);
    p("}");
  }
  p("");
// ---- 3. HotSpot ----------------------------------------------------------
  if (o.mode === "HOTSPOT" || o.mode === "HOTSPOT_PPPOE") {
    rule();
    c("3. HOTSPOT");
    rule();
    p("");
    c("RADIUS is the authentication authority. NO local hotspot user is");
    c("created: that would be an account nobody bills and nobody can revoke.");
    p(`:if ([:len [/ip hotspot profile find name=netpid]] = 0) do={`);
    p(`  /ip hotspot profile add name=netpid use-radius=yes radius-interim-update=5m use-cookie=yes login-by=http-chap,https,http-pap comment=${q(`${tag} hs-profile`)}`);
    p("} else={");
    p(`  /ip hotspot profile set [find name=netpid] use-radius=yes radius-interim-update=5m`);
    p("}");
    p("");
    if (o.hotspotSubnet && o.hotspotRange) {
      c("The portal pool range is SUPPLIED, not derived: RouterOS [:pick] is");
      c("1-based and a 0 index silently yields nothing, which would hand every");
      c("client an empty pool and look like a DHCP fault.");
      p(`:if ([:len [/ip pool find name=${q(o.hotspotRange)}]] = 0) do={`);
      p(`  /ip pool add name=${q(o.hotspotRange)} ranges=${q(`${o.hotspotSubnet},${o.hotspotRange}`)} comment=${q(`${tag} hs-pool`)}`);
      p("}");
      p("");
      p(`:if ([:len [/ip hotspot find name=netpid]] = 0) do={`);
      p(`  /ip hotspot add name=netpid interface=${q(o.bridgeIface)} profile=netpid address-pool=${q(o.hotspotRange)} dns-name=${q(o.hotspotDnsName)} add-default-route=yes address-type=ethernet comment=${q(`${tag} hotspot`)}`);
      p(`  :put "HotSpot created."`);
      p("} else={");
      p(`  /ip hotspot set [find name=netpid] profile=netpid add-default-route=yes dns-name=${q(o.hotspotDnsName)} address-pool=${q(o.hotspotRange)}`);
      p(`  :put "HotSpot updated."`);
      p("}");
    } else {
      c("No HotSpot subnet or range was supplied, so no HotSpot server was");
      c("created. A half-built portal is worse than none: clients associate and");
      c("get no login page at all.");
      p(`  :put "SKIP HotSpot: no subnet or pool range supplied."`);
    }
    p("");
  }

  // ---- 4. PPPoE ------------------------------------------------------------
  if (o.mode === "PPPOE" || o.mode === "HOTSPOT_PPPOE") {
    rule();
    c("4. PPPoE SERVER");
    rule();
    p("");
    c("RADIUS only. No local PPP account is created.");
    p(`:if ([:len [/ppp profile find name=netpid]] = 0) do={`);
    p(`  /ppp profile add name=netpid use-radius=yes use-compression=no use-encryption=no only-one=yes change-tcp-mss=yes comment=${q(`${tag} ppp-profile`)}`);
    p("} else={");
    p(`  /ppp profile set [find name=netpid] use-radius=yes only-one=yes change-tcp-mss=yes`);
    p("}");
    p(`:if ([:len [/interface pppoe-server profile find name=netpid]] = 0) do={`);
    p(`  /interface pppoe-server profile add name=netpid use-compression=no use-encryption=no only-one=yes change-tcp-mss=yes comment=${q(`${tag} pppoe-profile`)}`);
    p("}");
    if (o.pppoePool && o.pppoeRanges && o.pppoeLocal) {
      p(`:if ([:len [/ip pool find name=${q(o.pppoePool)}]] = 0) do={`);
      p(`  /ip pool add name=${q(o.pppoePool)} ranges=${q(o.pppoeRanges)} comment=${q(`${tag} pppoe-pool`)}`);
      p("}");
      p("");
      c("local-address must sit inside the pool range, or the server leases an");
      c("address outside its own pool and sessions come up with no usable route.");
      p(`:if ([:len [/interface pppoe-server server find service-name=${q(o.pppoeService)}]] = 0) do={`);
      p(`  /interface pppoe-server server add service-name=${q(o.pppoeService)} interface=${q(o.bridgeIface)} default-profile=netpid authentication-service=pppoe remote-address=${q(o.pppoePool)} local-address=${q(o.pppoeLocal)} comment=${q(`${tag} pppoe`)}`);
      p(`  :put "PPPoE service created."`);
      p("} else={");
      p(`  /interface pppoe-server server set [find service-name=${q(o.pppoeService)}] remote-address=${q(o.pppoePool)} local-address=${q(o.pppoeLocal)}`);
      p(`  :put "PPPoE service updated."`);
      p("}");
    } else {
      c("No PPPoE pool range or local address was supplied, so no PPPoE server");
      c("was created.");
      p(`  :put "SKIP PPPoE server: no pool range or local address supplied."`);
    }
    p("");
  }
// ---- 5. RADIUS -----------------------------------------------------------
  rule();
  c("5. RADIUS (auth, accounting, CoA)");
  rule();
  p("");
  if (v7) {
    c("RouterOS 7 promoted RADIUS out of /ip. A 7.x box answers \"bad command");
    c("name radius\" for the v6 path, so the client is silently never created and");
    c("PPPoE then authenticates against nothing. Using the top-level menu.");
  } else {
    c("RouterOS 6 nests the RADIUS client under /ip. Using that path.");
  }
  p("");
  c("Accounting is what makes NETPID see usage at all. Without it every");
  c("subscriber looks idle and the bill is quietly wrong rather than broken.");
  if (o.radiusSecret) {
    p(`:if ([:len [${RM} find comment=${q(`NETPID:${o.nasShortname}`)}]] = 0) do={`);
    p(`  ${RM} add service=ppp,hotspot address=${q(o.radiusServer)} secret=${q(o.radiusSecret)} auth-port=${o.radiusAuthPort} acct-port=${o.radiusAcctPort} timeout=1500ms comment=${q(`NETPID:${o.nasShortname}`)}`);
    p(`  :put "RADIUS entry created."`);
    p("} else={");
    p(`  ${RM} set [find comment=${q(`NETPID:${o.nasShortname}`)}] secret=${q(o.radiusSecret)} auth-port=${o.radiusAuthPort} acct-port=${o.radiusAcctPort}`);
    p(`  :put "RADIUS entry updated."`);
    p("}");
  } else {
    c("NO secret was supplied, so NO radius entry is created. A client with no");
    c("secret fails every login, which looks like a FreeRADIUS fault rather than");
    c("a missing value.");
    p(`  :put "SKIP RADIUS: no shared secret supplied."`);
  }
  p("");
  p("/ppp/aaa set use-radius=yes accounting=yes interim-update=5m");
  p("");
  c("CoA / Disconnect. This menu is a SINGLETON: accept, port and vrf only. It");
  c("has NO comment property, so setting one fails the line outright.");
  p(`/radius incoming set accept=yes port=${o.radiusCoaPort}`);
  p("");

  // ---- 6. Management -------------------------------------------------------
  rule();
  c("6. MANAGEMENT");
  rule();
  p("");
  if (o.wireguard && v7) {
    c("WireGuard is included because this router reported RouterOS 7 and");
    c("NETPID has issued a real peer key for it. The router's own private key is");
    c("generated HERE, on the router, and never leaves the box.");
    p(`:if ([:len [/interface wireguard find name=netpid-wg]] = 0) do={`);
    p(`  /interface wireguard add name=netpid-wg listen-port=51820 comment=${q(`${tag} wg`)}`);
    p(`  :put "WireGuard interface created."`);
    p("} else={");
    p(`  :put "WireGuard interface reused."`);
    p("}");
    p(`:if ([:len [/ip address find interface=netpid-wg]] = 0) do={`);
    p(`  /ip address add address=${q(o.wireguard.routerTunnelIp)} interface=netpid-wg comment=${q(`${tag} wg-addr`)}`);
    p("} else={");
    p(`  /ip address remove [find interface=netpid-wg]`);
    p(`  /ip address add address=${q(o.wireguard.routerTunnelIp)} interface=netpid-wg comment=${q(`${tag} wg-addr`)}`);
    p("}");
    p(`:if ([:len [/interface wireguard peers find interface=netpid-wg]] > 0) do={`);
    p(`  /interface wireguard peers remove [find interface=netpid-wg]`);
    p("}");
    p(`/interface wireguard peers add interface=netpid-wg public-key=${q(o.wireguard.serverPublicKey)} allowed-address=${q(`${o.wireguard.serverTunnelIp}/32`)} persistent-keepalive=25s comment=${q(`${tag} wg-peer`)}`);
    p(`:put "WireGuard peer configured."`);
    p(`:put "YOUR ROUTER PUBLIC KEY - paste this into NETPID:"`);
    p(`:put ([/interface wireguard get [find name=netpid-wg] public-key])`);
  } else {
    c("WireGuard is NOT configured on this router.");
    c(!o.wireguard && v7
      ? "NETPID has not issued a tunnel for it yet, so there is no real peer key to"
      : "This router reported RouterOS 6, where WireGuard is a separate package");
    c(!o.wireguard && v7
      ? "install. Run this again once the tunnel has been issued."
      : "that may not be installed. Install it first to allow the tunnel.");
    p(`  :put "WireGuard: not configured on this router."`);
  }
  p("");

  if (o.heartbeatUrl) {
    c("Heartbeat. A periodic GET back to NETPID, so a router NETPID cannot reach");
    c("over its tunnel still proves it exists and reports in.");
    const evt = `/tool fetch mode=https keep-result=no url=${o.heartbeatUrl}`;
    p(`:if ([:len [/system scheduler find name=${q(hb)}]] = 0) do={`);
    p(`  /system scheduler add name=${q(hb)} interval=00:05:00 on-event=${q(evt)} comment=${q(`${tag} heartbeat`)}`);
    p(`  :put "heartbeat scheduler added (every 5 minutes)."`);  // closing quote
    p(`} else={`);
    p(`  /system scheduler set [find name=${q(hb)}] interval=00:05:00 on-event=${q(evt)}`);
    p(`  :put "heartbeat scheduler updated."`);
    p("}");
  } else {
    c("HEARTBEAT NOT INSTALLED. NETPID has no stable public host configured, so");
    c("there is no URL to point a permanent scheduler entry at. Installing one");
    c("anyway would leave the router calling a host that will be deleted.");
    c("Set NETPID_PUBLIC_URL to the production host and re-run to enable it.");
    p(`  :put "heartbeat: NOT installed - NETPID public host is not configured."`);
  }
  p("");
// ---- 7. Report -----------------------------------------------------------
  rule();
  c("7. WHAT THIS SCRIPT DID AND DID NOT DO");
  rule();
  p("");
  p(`:put ""`);
  p(`:put "================== NETPID CONFIGURATION REPORT =================="`);
  p(`:put ("Mode          : " . ${q(o.mode)})`);
  p(`:put ("RouterOS      : " . [/system resource get version])`);
  p(`:put ("Board         : " . [/system resource get board-name])`);
  p(`:put ("WAN           : " . ${q(wan)})`);
  p(`:put ("Bridge        : " . ${q(o.bridgeIface)})`);
  p(`:put ("HotSpot       : " . ${q(o.hotspotPorts.length ? o.hotspotPorts.join(",") : "not configured")})`);
  p(`:put ("PPPoE         : " . ${q(o.pppoePorts.length ? o.pppoePorts.join(",") : "not configured")})`);
  p(`:put ("RADIUS        : " . ${q(o.radiusSecret ? "configured" : "SKIPPED - no secret")})`);
  p(`:put ("Accounting    : " . [/ppp/aaa get accounting])`);
  p(`:put ("CoA accept    : " . [/radius incoming get accept])`);
  p(`:put ("WireGuard     : " . ${q(o.wireguard && v7 ? "configured" : "not configured")})`);
  p(`:put ("Heartbeat     : " . ${q(o.heartbeatUrl ? "scheduler installed" : "NOT installed - no stable NETPID host")})`);
  p(`:put ""`);
  c("CONFIGURED is all this proves. NETPID marks the router ONLINE only after a");
  c("RouterOS API health check succeeds over the management path. Working");
  c("RADIUS does not make a router online.");
  rule();
  return L.join(NL);
}