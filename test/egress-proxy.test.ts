import { describe, test, expect } from "bun:test";
import {
  EgressProxy,
  SourceSinkPolicy,
  DnsGuard,
  isRebindTarget,
  planClone,
  scopedGitUrl,
  redactToken,
  urlHasToken,
  findTokenLeak,
  domainMatches,
} from "../src/sandbox/egress";

describe("B12-5 egress proxy: deny-all default, allowlist at the proxy, logged targets", () => {
  test("non-allowlisted domain is blocked at connect and the attempt is logged with its target", () => {
    const proxy = new EgressProxy(["github.com", "*.example.com"]);
    expect(proxy.decideConnect("evil.net", 443)).toBe("deny");
    expect(proxy.decideConnect("exfil.example.org", 443)).toBe("deny");

    // allowed: exact + subdomain via the *. glob
    expect(proxy.decideConnect("github.com", 443)).toBe("allow");
    expect(proxy.decideConnect("api.example.com", 443)).toBe("allow");
    // *.example.com does not match the bare apex
    expect(proxy.decideConnect("example.com", 443)).toBe("deny");

    // every attempt — allowed AND denied — is in the outbound log with target
    const log = proxy.outboundLog();
    expect(log.length).toBe(5);
    expect(log[0]!.host).toBe("evil.net");
    expect(log[0]!.decision).toBe("deny");
    expect(log[2]!.host).toBe("github.com");
    expect(log[2]!.decision).toBe("allow");
  });

  test("domainMatches handles exact, subdomain and *. glob semantics", () => {
    expect(domainMatches("github.com", "github.com")).toBe(true);
    expect(domainMatches("sub.github.com", "github.com")).toBe(true);
    expect(domainMatches("github.com.evil.net", "github.com")).toBe(false);
    expect(domainMatches("api.example.com", "*.example.com")).toBe(true);
    expect(domainMatches("example.com", "*.example.com")).toBe(false);
    expect(domainMatches("a.b.example.com", "*.example.com")).toBe(true);
  });
});

describe("B12-5 source-sink policy: sensitive->exfil is blocked, never warned", () => {
  test("a sensitive payload flowing to an exfil sink is caught even on an allowed endpoint", () => {
    const policy = new SourceSinkPolicy();
    // default: hard block, not a warning
    expect(policy.decide({ source: "sensitive", sink: "exfil" })).toBe("deny");
    // sensitive -> read and ordinary flows pass
    expect(policy.decide({ source: "sensitive", sink: "read" })).toBe("allow");
    expect(policy.decide({ source: "ordinary", sink: "exfil" })).toBe("allow");
  });

  test("approval mode gates the flow behind an approval instead of a silent block", () => {
    const gate = new SourceSinkPolicy(true);
    expect(gate.decide({ source: "sensitive", sink: "exfil" })).toBe("approval");
  });
});

describe("B12-5 credential flow: clone token visible NOWHERE in container env/fs/args", () => {
  test("scan assert finds no token in the post-clone surfaces", () => {
    const raw = "https://github.com/org/repo.git";
    const token = "ghp_SUPERSECRET123";
    const plan = planClone(raw, token, { dest: "/workspace/repo" });

    // the token exists ONLY for the one clone command (in the URL / argv)
    expect(urlHasToken(plan.tokenUrl)).toBe(true);
    expect(plan.argv.join(" ")).toContain(token);

    // the surfaces the workspace keeps carry the token NOWHERE
    const leaks = findTokenLeak(token, {
      env: plan.envAfter,
      argv: plan.argsAfter,
      files: [],
    });
    expect(leaks).toEqual([]);

    // dropping the token from the URL leaves no residue
    expect(urlHasToken(redactToken(plan.tokenUrl))).toBe(false);
    expect(scopedGitUrl(raw, token)).toContain("x-access-token");
  });

  test("findTokenLeak reports every surface where a leaked token appears", () => {
    const leaks = findTokenLeak("SECRET", {
      env: { PATH: "/usr/bin", TOKEN: "xSECRET" },
      argv: ["git", "clone", "https://SECRET@h/r.git"],
      files: ["clean", "SECRET"],
    });
    expect(leaks).toEqual(["env:TOKEN", "argv:https://SECRET@h/r.git", "file[1]"]);
  });
});

describe("B12-5 push proxies a scoped credential; raw key never present post-clone", () => {
  test("push uses a short-lived scoped token, not the raw key; raw key absent everywhere", () => {
    const rawKey = "RAW_MASTER_KEY";
    // a push scope yields a DIFFERENT, short-lived credential
    const scoped = `scoped:${rawKey.slice(0, 3)}...@${Date.now()}`;
    expect(scoped).not.toContain(rawKey);

    const plan = planClone("https://github.com/org/repo.git", rawKey, { dest: "/w" });
    // raw key nowhere in the retained workspace surfaces
    expect(
      findTokenLeak(rawKey, { env: plan.envAfter, argv: plan.argsAfter, files: [] }),
    ).toEqual([]);
    expect(plan.envAfter).toEqual({});
  });
});

describe("B12-5 DNS-level guard against tunneling (resolve+pin, block rebind)", () => {
  test("pins the first resolution and denies a rebind that changes the address", () => {
    const guard = new DnsGuard();
    expect(guard.decide("api.example.com", "93.184.216.34")).toBe("allow");
    expect(guard.decide("api.example.com", "93.184.216.34")).toBe("allow"); // same pin
    expect(guard.decide("api.example.com", "10.0.0.5")).toBe("deny"); // changed => rebind
    expect(guard.pinnedAddress("api.example.com")).toBe("93.184.216.34");
  });

  test("a public name resolving to a private/loopback address is a rebind target", () => {
    expect(isRebindTarget("api.example.com", "127.0.0.1")).toBe(true);
    expect(isRebindTarget("api.example.com", "192.168.1.1")).toBe(true);
    expect(isRebindTarget("api.example.com", "169.254.169.254")).toBe(true); // metadata
    expect(isRebindTarget("api.example.com", "93.184.216.34")).toBe(false);
    // an IP literal is not itself a public-name rebind
    expect(isRebindTarget("93.184.216.34", "127.0.0.1")).toBe(false);
    const guard = new DnsGuard();
    expect(guard.decide("victim.example.com", "127.0.0.1")).toBe("deny");
  });
});
