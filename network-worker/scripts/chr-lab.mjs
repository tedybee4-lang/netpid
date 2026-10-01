/**
 * Build and boot a real MikroTik CHR so the generated script is executed by
 * RouterOS instead of by my model of RouterOS.
 *
 * This exists because three rounds of "verified" scripts each reached a real
 * router and failed on something no static analysis could see:
 *
 *   line 60 col 157  a parenthesised expression split across lines
 *   line 65 col 6   :set on a variable never declared with :local
 *   line 89 col 6   :set on a :foreach variable, out of scope after the loop
 *
 * Asserting those rules in JavaScript proved only that my model was
 * self-consistent, which is the assumption that was wrong three times.
 *
 * Run: node scripts/chr-lab.mjs up | import <file.rsc> | run <cmds> | state | down
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { runOnChr, importScript } from "./chr-exec.mjs";

const VBOX = "C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe";
const VM = "netpid-chr-lab";
const VHD = `${process.env.TEMP}\\chr\\chr-7.23.7.vhd`;

/** VirtualBox NAT does not expose guest ports unless a rule is added. */
const HOST_PORT = 8722;
const GUEST_PORT = 8728;

const vbox = (...args) =>
  execFileSync(VBOX, args, { encoding: "utf8", timeout: 180_000 });
const say = (s) => console.log(s);

function vmState() {
  try {
    return vbox("showvminfo", VM, "--machinereadable").split("\n")
      .find((l) => l.startsWith("VMState="))?.split("=")[1]?.replace(/"/g, "")
      ?? "unknown";
  } catch { return "absent"; }
}

/** A TCP connect is enough to know RouterOS has finished booting. */
function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 2000 }, () => {
      s.destroy(); resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

import net from "node:net";

const cmd = process.argv[2] ?? "";

if (cmd === "up") {
  if (vmState() === "absent") {
    if (!existsSync(VHD)) {
      say(`  CHR disk missing at ${VHD}`);
      say("  download: https://download.mikrotik.com/routeros/7.23.7/chr-7.23.7.vhd.zip");
      process.exit(1);
    }
    say("  creating VM...");
    vbox("createvm", "--name", VM, "--ostype", "Linux_64", "--register");
    vbox("modifyvm", VM, "--memory", "1024", "--cpus", "2");
    // 82540EM, not virtio. CHR's VirtualBox build has no virtio-net driver,
    // so a virtio NIC leaves the guest with no network and the box looks like
    // it booted fine while being completely unreachable. VirtualBox 7.x names
    // chipsets rather than drivers: 82540EM is the Intel PRO/1000 that CHR
    // expects, and the string "e1000" is rejected outright.
    vbox("modifyvm", VM, "--nic1", "nat", "--nictype1", "82540EM");
    vbox("modifyvm", VM,
      "--natpf1", `chr-api,tcp,127.0.0.1,${HOST_PORT},,${GUEST_PORT}`);
    vbox("storagectl", VM, "--name", "SATA", "--add", "sata");
    vbox("storageattach", VM, "--storagectl", "SATA",
      "--port", "0", "--device", "0", "--type", "hdd", "--medium", VHD);
    // No serial port. Everything goes through the RouterOS API, and VirtualBox
    // 7.2 rejects --uartmode with an unhelpful usage dump, which is not worth
    // debugging for a console the harness does not read.
    say("  VM created");
  } else {
    say(`  VM exists (${vmState()})`);
  }

  if (vmState() !== "running") {
    say("  booting...");
    vbox("startvm", VM, "--type", "headless");
  }
  say("  waiting for RouterOS (up to 5 minutes)...");
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    if (await probe(HOST_PORT)) {
      say(`  RouterOS API reachable on 127.0.0.1:${HOST_PORT}`);
      process.exit(0);
    }
  }
  say("  timed out waiting for the CHR");
  process.exit(1);
}

if (cmd === "import") {
  const file = process.argv[3];
  if (!file) { say("usage: chr-lab.mjs import <file.rsc>"); process.exit(2); }
  say(await importScript(readFileSync(file, "utf8"), HOST_PORT));
  process.exit(0);
}

if (cmd === "run") {
  say(await runOnChr(process.argv.slice(3).join(" "), HOST_PORT));
  process.exit(0);
}

if (cmd === "down") {
  try { vbox("controlvm", VM, "poweroff"); } catch { /* may already be off */ }
  try { vbox("unregistervm", VM, "--delete"); say("  VM removed"); }
  catch { say("  VM already gone"); }
  process.exit(0);
}

if (cmd === "state") {
  say(`  ${vmState()}`);
  process.exit(0);
}

say("usage: node scripts/chr-lab.mjs up | import <file.rsc> | run <cmds> | state | down");
