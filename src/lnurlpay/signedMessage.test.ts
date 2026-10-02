import { expect } from "jsr:@std/expect";
import {
  available,
  descriptionHash,
  recover,
  register,
  unregister,
  VALIDITY_SECS,
  VERSION,
} from "./signedMessage.ts";

// Golden vectors from Breez `lnurl-models/src/signed_message.rs` (`golden_vectors`).
// Expected strings are typed literally so the builders are never compared with themselves.
const DOMAIN = "lnurl.example.com";
const ALICE = "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc";
const TS = 1_700_000_000;

Deno.test("descriptionHash is lowercase sha256 hex of the exact bytes", () => {
  expect(descriptionHash("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(descriptionHash("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  // No trimming or normalization: a trailing space changes the hash.
  expect(descriptionHash("abc ")).not.toBe(descriptionHash("abc"));
});

Deno.test("register builds the golden v2 message", () => {
  expect(register(DOMAIN, "alice", "Pay to alice", TS)).toBe(
    "breez-lnurl:v2\nregister\nlnurl.example.com\nalice\n" +
      "0261d8b11c7eba9f71ccf5180df58416d3b2d19ba917caf57ba4bacead3ce2c2" +
      "\n1700000000",
  );
});

Deno.test("unregister, recover, and available build the golden v2 messages", () => {
  expect(unregister(DOMAIN, "alice", TS)).toBe(
    "breez-lnurl:v2\nunregister\nlnurl.example.com\nalice\n1700000000",
  );
  expect(recover(DOMAIN, ALICE, TS)).toBe(
    "breez-lnurl:v2\nrecover\nlnurl.example.com\n" +
      "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc\n1700000000",
  );
  expect(available(DOMAIN, ALICE, "alice", TS)).toBe(
    "breez-lnurl:v2\navailable\nlnurl.example.com\n" +
      "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc\nalice\n1700000000",
  );
});

Deno.test("a description with the separator stays one hashed field", () => {
  const sneaky = "x\n1700000000";
  const message = register(DOMAIN, "alice", sneaky, TS);
  expect(message.split("\n").length - 1).toBe(5);
  expect(message.includes(sneaky)).toBe(false);
});

Deno.test("every message leads with the version and routes build distinct messages", () => {
  expect(VERSION).toBe("breez-lnurl:v2");
  expect(VALIDITY_SECS).toBe(600);
  const messages = [
    register(DOMAIN, "alice", "d", 1),
    unregister(DOMAIN, "alice", 1),
    recover(DOMAIN, ALICE, 1),
    available(DOMAIN, ALICE, "alice", 1),
  ];
  for (const message of messages) expect(message.startsWith("breez-lnurl:v2\n")).toBe(true);
  expect(new Set(messages).size).toBe(messages.length);
  // A domain is one field: a crafted username cannot read as another domain.
  expect(unregister("a.com", "x", 1)).not.toBe(unregister("a.com\nx", "alice", 1));
});
