import { describe, test, expect } from "bun:test";
import {
  classifyRisk,
  evaluateRisk,
  tierToAction,
  canAutoApprove,
  confirmationStrength,
  isT2,
  RISK_TIER_BY_TOOL,
  DEFAULT_RISK_TIER,
  KNOWN_TOOLS,
  defaultRiskRules,
  type RiskRule,
} from "../src/security/risk-tiers";
// The risk-tier API must also be reachable through the guard module (#401 task
// lives in src/security/guard.ts) — assert the re-export works.
import { classifyRisk as guardClassifyRisk } from "../src/security/guard";

describe("B13-3 tier classification (T0 auto / T1 ask / T2 strongest confirm)", () => {
  test("T0 read-only auto-approves without a prompt", () => {
    expect(classifyRisk("read_file", { path: "src/a.ts" })).toBe("T0");
    expect(classifyRisk("grep", {})).toBe("T0");
    expect(tierToAction("T0")).toBe("ALLOW");
    expect(canAutoApprove("T0", "auto")).toBe(true);
    expect(confirmationStrength("T0")).toBe("normal");
  });

  test("T1 write/exec always asks", () => {
    expect(classifyRisk("write_file", { path: "x.txt" })).toBe("T1");
    expect(classifyRisk("bash", { command: "ls -la" })).toBe("T1");
    expect(classifyRisk("browser", { action: "navigate", url: "https://example.com" })).toBe("T1");
    expect(classifyRisk("web_fetch", { url: "https://example.com" })).toBe("T1");
    expect(tierToAction("T1")).toBe("ASK");
    expect(canAutoApprove("T1", "auto")).toBe(false);
    expect(confirmationStrength("T1")).toBe("normal");
  });

  test("T2 irreversible/credential prompts with the strongest confirmation shape", () => {
    expect(classifyRisk("bash", { command: "rm -rf /tmp/x" })).toBe("T2");
    expect(classifyRisk("bash", { command: "git push --force origin main" })).toBe("T2");
    expect(classifyRisk("bash", { command: "DROP TABLE users" })).toBe("T2");
    expect(classifyRisk("bash", { command: "env" })).toBe("T2");
    expect(classifyRisk("bash", { command: "printenv OPENAI_API_KEY" })).toBe("T2");
    expect(classifyRisk("bash", { command: "cat /proc/self/environ" })).toBe("T2");
    expect(classifyRisk("bash", { command: "node -e 'console.log(process.env)'" })).toBe("T2");
    expect(classifyRisk("bash", { command: "echo hi", sandbox: "off" })).toBe("T2");
    expect(classifyRisk("write_file", { path: "/home/u/.env" })).toBe("T2");
    // A read tool still escalates to T2 on credential access.
    expect(classifyRisk("read_file", { path: "/home/u/.env" })).toBe("T2");
    expect(isT2("T2")).toBe(true);
    expect(confirmationStrength("T2")).toBe("strong");
  });

  test("guard.ts re-exports the risk-tier API", () => {
    expect(guardClassifyRisk("read_file", {})).toBe("T0");
    expect(guardClassifyRisk("bash", { command: "rm -rf /x" })).toBe("T2");
  });
});

describe("B13-3 evaluation order DENY > ASK > ALLOW (order law)", () => {
  test("a broad deny beats a narrow allow even when listed first (specificity never reorders)", () => {
    // The narrow ALLOW is FIRST in the list and matches exactly; the broad
    // DENY is second. The law says DENY still wins: specificity never reorders
    // precedence. evaluateRisk re-sorts by DENY > ASK > ALLOW.
    const rules: RiskRule[] = [
      {
        id: "allow-harmless-bash",
        action: "ALLOW",
        tools: ["bash"],
        matchInput: (i) => typeof (i as any)?.command === "string" && (i as any).command.startsWith("echo"),
      },
      { id: "deny-all-bash", action: "DENY", tools: ["bash"] },
    ];
    expect(evaluateRisk(rules, "bash", { command: "echo hi" })).toBe("DENY");
    expect(evaluateRisk(rules, "bash", { command: "rm -rf /x" })).toBe("DENY");
  });

  test("DENY and ASK outrank ALLOW; unmatched calls fall back to the tier default", () => {
    const rules: RiskRule[] = [
      { id: "ask-writes", action: "ASK", tools: ["write_file"] },
      { id: "allow-reads", action: "ALLOW", tools: ["read_file"] },
    ];
    // ask rule beats allow rule for a matching write.
    expect(evaluateRisk(rules, "write_file", { path: "a.txt" })).toBe("ASK");
    // unmatched tool falls back to tier default (bash -> ASK).
    expect(evaluateRisk(rules, "bash", { command: "ls" })).toBe("ASK");
  });

  test("default rule set denies MCP tools, allows reads", () => {
    expect(evaluateRisk(defaultRiskRules(), "mcp__server__tool", {})).toBe("DENY");
    expect(evaluateRisk(defaultRiskRules(), "read_file", { path: "a" })).toBe("ALLOW");
  });
});

describe("B13-3 bypass-mode guard (no path auto-approves T2)", () => {
  test("T2 is never auto-approvable under ANY approval mode", () => {
    for (const mode of ["auto", "ask", "strict", "full", "read-only", "allow", ""]) {
      expect(canAutoApprove("T2", mode)).toBe(false);
    }
  });

  test("a T2-tiered call is never auto-approvable regardless of mode", () => {
    const t2call = classifyRisk("bash", { command: "rm -rf /var/lib" });
    expect(isT2(t2call)).toBe(true);
    for (const mode of ["auto", "ask", "strict", "full"]) {
      expect(canAutoApprove(t2call, mode)).toBe(false);
    }
  });

  test("only T0 auto-approves; T1 always asks", () => {
    expect(canAutoApprove("T0", "auto")).toBe(true);
    expect(canAutoApprove("T1", "auto")).toBe(false);
    expect(canAutoApprove("T1", "allow")).toBe(false);
  });
});

describe("B13-3 classification table covers all registered tools", () => {
  test("every known registered tool has an explicit tier", () => {
    for (const tool of KNOWN_TOOLS) {
      expect(RISK_TIER_BY_TOOL[tool], `missing tier for ${tool}`).toBeDefined();
      expect(classifyRisk(tool, {})).toBe(RISK_TIER_BY_TOOL[tool]!);
    }
  });

  test("unknown/dynamic tools (incl. mcp__*) fall back to the conservative default T1", () => {
    expect(RISK_TIER_BY_TOOL["mcp__x__y"]).toBeUndefined();
    expect(DEFAULT_RISK_TIER).toBe("T1");
    expect(classifyRisk("mcp__x__y", {})).toBe("T1");
    expect(classifyRisk("some_future_tool", {})).toBe("T1");
  });
});
