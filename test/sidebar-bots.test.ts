import { describe, test, expect } from "bun:test";
import { botSectionItems } from "../src/gateway/console/sidebar-bots.js";

describe("console sidebar bot section (#276)", () => {
  const atlas = { name: "atlas", model: "gpt-4o" };
  const noModel = { name: "rawbot" };
  const emptyName = { name: "", model: "x" };
  const missing = { model: "y" };

  test("maps each bot to name/model/active with the current bot highlighted", () => {
    const items = botSectionItems([atlas, noModel], "atlas");
    expect(items).toEqual([
      { name: "atlas", model: "gpt-4o", active: true },
      { name: "rawbot", model: "", active: false },
    ]);
  });

  test("returns empty for no bots or a null list", () => {
    expect(botSectionItems([], "solo")).toEqual([]);
    expect(botSectionItems(null, "solo")).toEqual([]);
    expect(botSectionItems(undefined, "solo")).toEqual([]);
  });

  test("drops entries without a usable name (dead links)", () => {
    const items = botSectionItems([atlas, emptyName, missing], "solo");
    expect(items.map((i) => i.name)).toEqual(["atlas"]);
  });

  test("solo never appears — it is a scope, not a bot", () => {
    const items = botSectionItems([{ name: "solo" }], "solo");
    expect(items).toEqual([{ name: "solo", model: "", active: true }]);
  });
});
