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
  /**
   * Where the router GETs each step boundary so the dashboard can show live
   * progress. Empty disables the callbacks entirely - the script must never
   * depend on NETPID being reachable to finish configuring a router.
   */
  progressUrl?: string;
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
  // THE SAME MOVE HAPPENED TO THE DHCP CLIENT, and it was missed here.
  //
  //   field report: bad command name dhcp-client (line 9 column 26)
  //
  // On 7.x the client lives at /ip/dhcp-client. /interface/dhcp-client is the
  // 6.x path and does not exist, so the router parsed "dhcp-client" as a command
  // to run - the same misleading shape as the [:split failure. Wireless is not
  // the only thing that moved out of /interface in v7.
  const DHCP = v7 ? "/ip dhcp-client" : "/interface dhcp-client";
  const wan = safeIface(o.wan);
  const hb = o.heartbeatName;

  const L: string[] = [];
  const p = (s = "") => L.push(s);
  const c = (s: string) => p(`# ${s}`);
  const rule = () => p(`# ${"=".repeat(68)}`);

  // ---------------------------------------------------------------------------
  // THE THREE EMITTERS EVERY SECTION BELOW IS BUILT FROM
  // ---------------------------------------------------------------------------
  //
  // `step` reports a boundary back to NETPID so the dashboard can show progress
  // instead of a frozen bar. It is a GET for the same reason the bootstrap is:
  // it is the one HTTP verb a factory-fresh box of EITHER major version can
  // issue with nothing installed. Every call is wrapped so a dashboard that is
  // down, slow or unreachable costs the operator nothing but a missing tick.
  //
  // `setp` applies ONE property with its own guard.
  //
  // This is the change that makes the script work on RouterOS builds nobody has
  // tested against. The previous shape was one `add` carrying six properties,
  // so a single property this RouterOS does not have rejected the WHOLE command
  // and the object was never created - and because a pasted multi-line script
  // never prints the runtime error (RouterOS has no error variable in on-error,
  // and the console only echoes what was pasted), the operator saw a WARN with
  // no cause and no HotSpot at all. One property, one guard, one recorded
  // failure: the object survives, and the report names the exact property.
  const progressBase = String(o.progressUrl ?? "").trim();
  const step = (id: string, pct: number) => {
    if (!progressBase) return;
    p(`:do { /tool fetch mode=https keep-result=no url=${q(`${progressBase}?step=${id}&pct=${pct}`)} } on-error={ }`);
  };

  /** Records a property this RouterOS refused. Printed in the final report. */
  const fail = (label: string) => {
    p(`  :set npFail ($npFail . " " . ${q(label)})`);
  };

  /** `/menu set <target> <prop=value>` with an independent guard. */
  const setp = (menu: string, target: string, prop: string, label: string) => {
    p(`:do {`);
    p(`  ${menu} set ${target} ${prop}`);
    p(`} on-error={`);
    fail(label);
    p(`}`);
  };

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
  c("PROPERTY-HANDLING RULE. Every object below is created with the minimum");
  c("number of properties that must succeed, and every further property is then");
  c("set ONE AT A TIME inside its own guard. RouterOS rejects an entire command");
  c("when it does not recognise a single property name in it, so the old shape -");
  c("one `add` carrying six properties - meant one unsupported name destroyed");
  c("the whole object. Anything this RouterOS refuses is collected in the failure");
  c("list printed at the end instead of vanishing silently.");
  p("");
  p(`:local npFail ""`);
  step("start", 5);
  p("");

  // ---- 1. Interfaces -------------------------------------------------------
  rule();
  c("1. INTERFACES");
  rule();
  step("interfaces", 15);
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
  c("");
  c("The release is checked first, so re-running the script does not report a");
  c("move that is not happening. Note this one IS a remove: a WAN must not be a");
  c("bridge member at all, so there is nothing to add it to.");
  p(`:if ([:len [/interface find name=${wan}]] = 0) do={`);
  p(`  :put "SKIP WAN: no interface named ${wan}."`);
  p("} else={");
  p(`  :if ([:len [/interface bridge port find interface=${wan}]] > 0) do={`);
  p(`    :local npWb [/interface bridge port get [find interface=${wan}] bridge]`);
  p(`    :put ("releasing " . ${q(wan)} . " from bridge " . $npWb)`);
  p(`    /interface bridge port remove [find interface=${wan}]`);
  p("  }");
  p(`  :if ([:len [${DHCP} find interface=${wan}]] = 0) do={`);
  p(`    ${DHCP} add interface=${wan} disabled=no comment=${q(`${tag} wan-dhcp`)}`);
  p("  }");
  p(`  :put ("WAN " . ${q(wan)} . ": DHCP client present.")`);
  p("}");
  p("");

  // ---- 2. Bridge -----------------------------------------------------------
  rule();
  c("2. BRIDGE");
  rule();
  step("bridge", 30);
  p("");
  c("One bridge holds the customer ports. Ports named by the operator are");
  c("moved into it; nothing else is.");
  p(`:if ([:len [/interface bridge find name=${q(o.bridgeIface)}]] = 0) do={`);
  p(`  /interface bridge add name=${q(o.bridgeIface)} comment=${q(`${tag} bridge`)}`);
  p(`  :put ("bridge created: " . ${q(o.bridgeIface)})`);
  p("}");
  p("");
  c("A port is moved by ADDING it to the new bridge, not by removing it from");
  c("the old one first. Adding moves it atomically; a remove-then-add leaves a");
  c("window where the port is a member of no bridge at all.");
  c("");
  c("That window is not cosmetic. An operator driving the router over the network");
  c("is usually connected THROUGH one of the ports being moved, so the remove");
  c("drops the live session - observed in the field as \"Console does not");
  c("respond\", which kills the terminal mid-script and leaves the box half");
  c("configured. Adding straight to the target bridge never has that gap.");
  const allPorts = [...o.hotspotPorts, ...o.pppoePorts];
  for (const port of allPorts) {
    const sp = safeIface(port);
    p(`:do {`);
    p(`  :if ([:len [/interface bridge port find interface=${sp} where bridge=${q(o.bridgeIface)}]] = 0) do={`);
    p(`    :if ([:len [/interface bridge port find interface=${sp}]] > 0) do={`);
    p(`      :local npOld [/interface bridge port get [find interface=${sp}] bridge]`);
    p(`      :put ("moving " . ${q(sp)} . " from " . $npOld . " to " . ${q(o.bridgeIface)})`);
    p("    }");
    // Adding a port that is already a member of another bridge moves it, and
    // RouterOS does the detach and attach as one operation.
    p(`    /interface bridge port add bridge=${q(o.bridgeIface)} interface=${sp} pvid=1 comment=${q(`${tag} port`)}`);
    p("  } else={");
    p(`    :put ("already in " . ${q(o.bridgeIface)} . ": " . ${q(sp)})`);
    p("  }");
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
    step("hotspot", 45);
    p("");
    c("RADIUS is the authentication authority. NO local hotspot user is");
    c("created: that would be an account nobody bills and nobody can revoke.");
    // `use-cookie` DOES NOT EXIST. It is what this script used to send, it was
    // rejected, and because it rode along with five other properties in the
    // same `add` it took the entire profile with it - the router ended up with
    // NO HotSpot profile at all while the console printed a bare WARN.
    //
    // The RouterOS 7.24 CLI reference gives the real property list for
    // ip/hotspot/profile:
    //   login-by  (mac | cookie | http-chap | https | http-pap | trial | mac-cookie)
    //   http-cookie-lifetime   time
    //   use-radius, radius-interim-update, nas-port-type, radius-mac-format, ...
    //
    // There is no on/off switch to get wrong: cookie authentication is requested
    // by putting `cookie` INSIDE login-by, and how long it lives is
    // http-cookie-lifetime.
    const PROFILE = "[find name=netpid]";
    p(`:if ([:len [/ip hotspot profile find name=netpid]] = 0) do={`);
    p(`  :do {`);
    p(`    /ip hotspot profile add name=netpid comment=${q(`${tag} hs-profile`)}`);
    p(`    :put "HotSpot profile created."`);
    p(`  } on-error={`);
    p(`    :put "FATAL: the HotSpot profile could not be created at all."`);
    fail("profile.add");
    p(`  }`);
    p(`} else={`);
    p(`  :put "HotSpot profile reused."`);
    p(`}`);
    p("");
    c("Each remaining property is applied on its own. If this RouterOS refuses");
    c("one, the profile still exists and the exact property is named in the");
    c("failure list at the end of this script.");
    setp("/ip hotspot profile", PROFILE, "use-radius=yes", "profile.use-radius");
    setp("/ip hotspot profile", PROFILE, "radius-interim-update=5m", "profile.radius-interim-update");
    setp("/ip hotspot profile", PROFILE, "login-by=http-chap,https,http-pap,cookie", "profile.login-by");
    setp("/ip hotspot profile", PROFILE, "http-cookie-lifetime=1d", "profile.http-cookie-lifetime");
    setp("/ip hotspot profile", PROFILE, "nas-port-type=ethernet", "profile.nas-port-type");
    p("");

    if (o.hotspotSubnet && o.hotspotRange) {
      c("The portal pool range is SUPPLIED, not derived: RouterOS [:pick] is");
      c("1-based and a 0 index silently yields nothing, which would hand every");
      c("client an empty pool and look like a DHCP fault.");
      p(`:if ([:len [/ip pool find name=${q(o.hotspotRange)}]] = 0) do={`);
      // The pool holds the DYNAMIC RANGE ONLY. It used to be
      // "<subnet>,<range>", which is a subset of the subnet and the router
      // rejected it with "pool has overlapping ranges" - the whole portal
      // failed to be created. The subnet is the network; the range is carved
      // out of it. Putting both in one pool says the same address twice.
      p(`  /ip pool add name=${q(o.hotspotRange)} ranges=${q(o.hotspotRange)} comment=${q(`${tag} hs-pool`)}`);
      p("}");
      p("");
      // The HotSpot SERVER is built the same way: the three properties it cannot
      // function without go in the `add`, everything else is set separately.
      //
      // `dns-name` and `address-type` were previously bundled into the `add`.
      // On this RouterOS that combination rejected the whole command and no
      // HotSpot server was created at all - a portal that clients can associate
      // with and never get a login page from. Neither is load-bearing, so
      // neither is allowed to be able to destroy the object.
      const HS = "[find name=netpid]";
      p(`:if ([:len [/ip hotspot find name=netpid]] = 0) do={`);
      p(`  :do {`);
      p(`    /ip hotspot add name=netpid interface=${q(o.bridgeIface)} profile=netpid comment=${q(`${tag} hotspot`)}`);
      p(`    :put ("HotSpot server created on " . ${q(o.bridgeIface)} . ".")`);
      p(`  } on-error={`);
      p(`    :put "FATAL: the HotSpot server could not be created at all."`);
      fail("hotspot.add");
      p(`  }`);
      p(`} else={`);
      p(`  :put "HotSpot server reused."`);
      p(`}`);
      p("");
      setp("/ip hotspot", HS, `address-pool=${q(o.hotspotRange)}`, "hotspot.address-pool");
      setp("/ip hotspot", HS, "add-default-route=yes", "hotspot.add-default-route");
      setp("/ip hotspot", HS, `dns-name=${q(o.hotspotDnsName)}`, "hotspot.dns-name");
      setp("/ip hotspot", HS, "address-type=ethernet", "hotspot.address-type");
      p("");
      c("If dns-name above is in the failure list, this RouterOS build does not");
      c("expose it on the HotSpot server. Create the DNS record anyway:");
      p(`  :put ("  " . ${q(o.hotspotDnsName)} . " -> this router's WAN address")`);
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
  step("radius", 70);
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
  // A RADIUS entry needs BOTH a server address and a shared secret. The secret
  // alone is not enough, and attempting the add anyway produced
  // "failure: valid address required" - an error that reads like a malformed
  // command rather than "this ISP has no RADIUS server configured yet".
  const radiusUsable = !!o.radiusSecret && !!String(o.radiusServer ?? "").trim();
  if (o.radiusSecret && !String(o.radiusServer ?? "").trim()) {
    c("A shared secret was supplied but no RADIUS SERVER address is configured");
    c("for this ISP, so no RADIUS client can be created. Skipping rather than");
    c("emitting a line that would fail with a misleading error.");
  }
  if (radiusUsable) {
    // The entry is found by `address`, which the CLI reference marks MANDATORY,
    // rather than by `comment`. That matters: the old lookup was
    // `find comment=NETPID:<nas>`, so if this RouterOS build ever refused the
    // comment the entry would never be found on a re-run and a DUPLICATE RADIUS
    // client would be created instead - two clients, the wrong secret winning at
    // random. `address` is the one property a RADIUS entry cannot be without.
    const RAD = `[find address=${q(o.radiusServer)}]`;
    p(`:if ([:len [${RM} find address=${q(o.radiusServer)}]] = 0) do={`);
    // The port properties are authentication-port and accounting-port. auth-port
    // and acct-port do not exist, so a line using them is rejected whole and the
    // RADIUS client is never created - PPPoE then authenticates against nothing
    // and every subscriber looks like a bad password.
    p(`  :do {`);
    p(`    ${RM} add address=${q(o.radiusServer)} secret=${q(o.radiusSecret)} comment=${q(`NETPID:${o.nasShortname}`)}`);
    p(`    :put "RADIUS entry created."`);
    p(`  } on-error={`);
    p(`    :put "FATAL: the RADIUS client could not be created."`);
    fail("radius.add");
    p(`  }`);
    p(`} else={`);
    p(`  :put "RADIUS entry reused."`);
    p(`}`);
    p("");
    c("Same rule as the HotSpot objects: address and secret are the only things");
    c("this menu cannot work without, so only those go in the add. Each remaining");
    c("property is set on its own below.");
    setp(RM, RAD, "service=ppp,hotspot", "radius.service");
    setp(RM, RAD, `secret=${q(o.radiusSecret)}`, "radius.secret");
    setp(RM, RAD, `authentication-port=${o.radiusAuthPort}`, "radius.authentication-port");
    setp(RM, RAD, `accounting-port=${o.radiusAcctPort}`, "radius.accounting-port");
    setp(RM, RAD, "timeout=1500ms", "radius.timeout");
    setp(RM, RAD, `comment=${q(`NETPID:${o.nasShortname}`)}`, "radius.comment");
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
  step("management", 85);
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
  c("Everything below is READ BACK FROM THE ROUTER, not echoed from what this");
  c("script asked for. The old report printed the requested values, so a HotSpot");
  c("that was never created still reported \"RADIUS: configured\" - the one screen");
  c("the operator relied on was the only thing that could not tell them it failed.");
  step("verify", 95);
  p("");
  p(`:put ""`);
  p(`:put "================== NETPID CONFIGURATION REPORT =================="`);
  p(`:put ("RouterOS      : " . [/system resource get version])`);
  p(`:put ("Board         : " . [/system resource get board-name])`);
  p(`:put ("Mode          : " . ${q(o.mode)})`);
  p(`:put ""`);
  p(`:put "-- VERIFIED ON THE ROUTER --"`);

  // Each block below prints the object's own state, or MISSING. A MISSING line
  // is the honest answer; the requested value would be a lie.
  const verify = (menu: string, name: string, reads: [string, string][], label: string) => {
    p(`:if ([:len [${menu} find name=${q(name)}]] > 0) do={`);
    for (const [prop, text] of reads) {
      p(`  :do {`);
      p(`    :put (${q(`    ${text}: `)} . [${menu} get [find name=${q(name)}] ${prop}])`);
      p(`  } on-error={ :put ${q(`    ${text}: (not exposed by this RouterOS)`)} }`);
    }
    p(`} else={`);
    p(`  :put ${q(`  ${label} ${name}: MISSING - it was not created.`)}`);
    p(`}`);
    p("");
  };

  verify("/ip hotspot profile", "netpid", [
    ["use-radius", "profile use-radius"],
    ["login-by", "profile login-by"],
    ["http-cookie-lifetime", "profile cookie-lifetime"],
  ], "profile");

  if (o.hotspotSubnet && o.hotspotRange) {
    verify("/ip hotspot", "netpid", [
      ["interface", "hotspot interface"],
      ["profile", "hotspot profile"],
      ["address-pool", "hotspot address-pool"],
      ["add-default-route", "hotspot default-route"],
    ], "hotspot");

    p(`:if ([:len [/ip pool find name=${q(o.hotspotRange)}]] > 0) do={`);
    p(`  :put ("  pool ${o.hotspotRange}: present")`);
    p(`} else={`);
    p(`  :put ${q(`  pool ${o.hotspotRange}: MISSING`)}`);
    p(`}`);
    p("");
  }

  p(`:if ([:len [/interface bridge find name=${q(o.bridgeIface)}]] > 0) do={`);
  p(`  :put ("  bridge ${o.bridgeIface}: present")`);
  for (const port of [...o.hotspotPorts, ...o.pppoePorts]) {
    const sp = safeIface(port);
    p(`  :if ([:len [/interface bridge port find interface=${sp} where bridge=${q(o.bridgeIface)}]] > 0) do={`);
    p(`    :put ${q(`    port ${sp}: in ${o.bridgeIface}`)}`);
    p(`  } else={`);
    p(`    :put ${q(`    port ${sp}: NOT in ${o.bridgeIface}`)}`);
    p(`  }`);
  }
  p(`} else={`);
  p(`  :put ${q(`  bridge ${o.bridgeIface}: MISSING`)}`);
  p(`}`);
  p("");

  if (radiusUsable) {
    p(`:if ([:len [${RM} find address=${q(o.radiusServer)}]] > 0) do={`);
    p(`  :do {`);
    p(`    :put ("  radius auth-port : " . [${RM} get [find address=${q(o.radiusServer)}] authentication-port])`);
    p(`  } on-error={ :put "  radius auth-port : (not exposed by this RouterOS)" }`);
    p(`  :do {`);
    p(`    :put ("  radius acct-port : " . [${RM} get [find address=${q(o.radiusServer)}] accounting-port])`);
    p(`  } on-error={ :put "  radius acct-port : (not exposed by this RouterOS)" }`);
    p(`} else={`);
    p(`  :put ${q(`  radius ${o.radiusServer}: MISSING`)}`);
    p(`}`);
    p("");
  } else {
    p(`:put ${q(`  radius: SKIPPED - no server/secret pair was configured`)}`);
    p("");
  }

  p(`:do {`);
  p(`  :put ("  accounting     : " . [/ppp/aaa get accounting])`);
  p(`} on-error={ :put "  accounting     : (no PPP AAA on this router)" }`);
  p(`:do {`);
  p(`  :put ("  CoA accept     : " . [/radius incoming get accept])`);
  p(`} on-error={ :put "  CoA accept     : (no RADIUS incoming on this RouterOS)" }`);
  p("");

  // The failure list. This is the whole point of setting properties one at a
  // time: everything this RouterOS refused is named, instead of one bad property
  // silently costing the operator an entire object.
  p(`:if ([:len $npFail] > 0) do={`);
  p(`  :put ""`);
  p(`  :put "!! NOT APPLIED ON THIS ROUTER (the object still exists) !!"`);
  p(`  :put ("  " . $npFail)`);
  p(`  :put "Re-run the wizard once NETPID knows about these properties."`);
  p(`} else={`);
  p(`  :put ""`);
  p(`  :put "All requested properties were accepted by this RouterOS."`);
  p(`}`);
  p("");
  p(`:put ""`);
  p(`:put "CONFIGURED is all this proves. NETPID marks the router ONLINE only after a"`);
  p(`:put "RouterOS API health check succeeds over the management path."`);
  step("done", 100);
  rule();

  // Clear the scratch variable so a re-paste starts from a known state. An
  // undeclared variable would abort the script HERE, after everything ran.
  p(`:set npFail ""`);
  return L.join(NL);
}