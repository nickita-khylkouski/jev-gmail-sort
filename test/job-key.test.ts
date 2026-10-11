import { expect, test } from "bun:test";
import { jobKey } from "../extension/job-key.js";

const rows = [{ id: "abc", card: { subject: "Hello", body: "original", signals: "unread" } }];
const owner = { name: "Fixture", email: "me@example.test" };
test("an unchanged list reuses its sort job", () => {
  expect(jobKey(rows, "important", owner)).toBe(jobKey(structuredClone(rows), "important", { ...owner }));
});
test.each(["body", "subject", "signals"])("a changed %s invalidates a sort with the same thread ids", (field) => {
  const changed = structuredClone(rows);
  changed[0].card[field] = "changed";
  expect(jobKey(changed, "important", owner)).not.toBe(jobKey(rows, "important", owner));
});
test("different sentences and owners do not share a result", () => {
  expect(jobKey(rows, "deadline", owner)).not.toBe(jobKey(rows, "important", owner));
  expect(jobKey(rows, "important", { ...owner, email: "other@example.test" })).not.toBe(jobKey(rows, "important", owner));
});
