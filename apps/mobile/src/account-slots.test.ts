import { expect, test } from "vitest";
import { activeSlot, forgetSlot, newSlot, rememberAccount, savedAccounts, useSlot } from "./account-slots";

const SERVER = "https://agents.example.com";
const person = (slot: string, id: string) => ({ slot, server: SERVER, id, name: id, email: `${id}@example.com` });

test("several accounts stay signed in, each in its own slot", () => {
  expect(savedAccounts()).toEqual([]);
  // The account signed in before slots existed sits in the unnamed slot.
  expect(activeSlot()).toBe("");
  rememberAccount(person("", "ann"));
  const second = newSlot();
  expect(second).not.toBe("");
  useSlot(second);
  rememberAccount(person(second, "ben"));
  expect(activeSlot()).toBe(second);
  expect(savedAccounts().map((row) => row.id)).toEqual(["ben", "ann"]);

  // Recording the same slot again updates it in place.
  rememberAccount({ ...person(second, "ben"), name: "Ben B" });
  expect(savedAccounts()).toHaveLength(2);
  expect(savedAccounts()[0]!.name).toBe("Ben B");
});

test("the same account signed in twice keeps the newest slot and hands back the old one", () => {
  const again = newSlot();
  const replaced = rememberAccount(person(again, "ann"));
  expect(replaced.map((row) => row.slot)).toEqual([""]);
  expect(savedAccounts().filter((row) => row.id === "ann").map((row) => row.slot)).toEqual([again]);
  // The same person on another server is a different account.
  expect(rememberAccount({ ...person(newSlot(), "ann"), server: "https://other.example.com" })).toEqual([]);
});

test("signing out takes one slot off the list and leaves the rest", () => {
  const before = savedAccounts().length;
  forgetSlot(savedAccounts()[0]!.slot);
  expect(savedAccounts()).toHaveLength(before - 1);
});
