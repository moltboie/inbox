/**
 * Tests for fetch-helpers.ts — getRequestedFields column mapping.
 * Covers inbox #542: FETCH FLAGS must request the `answered` column so the
 * \Answered flag round-trips (STORE writes it, FETCH must read it back).
 * Also inbox #587: RFC822 / RFC822.HEADER / RFC822.TEXT alias BODY[] /
 * BODY[HEADER] / BODY[TEXT] (RFC 3501 §6.4.5) — must request the same columns
 * and emit the same bytes as their BODY[...] equivalents.
 */

import { describe, it, expect, mock } from "bun:test";

// fetch-helpers imports `logger` from "server"; stub it.
mock.module("server", () => ({
  logger: {
    warn: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {})
  }
}));

import { buildFetchResponsePart, getRequestedFields } from "./fetch-helpers";
import type { MailType } from "common";

describe("getRequestedFields", () => {
  describe("FLAGS", () => {
    it("requests every flag-backing column, including answered", () => {
      const fields = getRequestedFields([{ type: "FLAGS" }]);
      // \Seen, \Flagged, \Deleted, \Draft, \Answered all need their column.
      expect(fields.has("read")).toBe(true);
      expect(fields.has("saved")).toBe(true);
      expect(fields.has("deleted")).toBe(true);
      expect(fields.has("draft")).toBe(true);
      expect(fields.has("answered")).toBe(true);
    });
  });

  describe("ENVELOPE", () => {
    it("requests envelope header columns", () => {
      const fields = getRequestedFields([{ type: "ENVELOPE" }]);
      expect(fields.has("subject")).toBe(true);
      expect(fields.has("from")).toBe(true);
      expect(fields.has("messageId")).toBe(true);
    });
  });

  it("always includes uid", () => {
    expect(getRequestedFields([]).has("uid")).toBe(true);
  });

  it("unions columns across multiple data items", () => {
    const fields = getRequestedFields([{ type: "FLAGS" }, { type: "INTERNALDATE" }]);
    expect(fields.has("answered")).toBe(true);
    expect(fields.has("date")).toBe(true);
  });

  describe("RFC822 aliases (inbox #587)", () => {
    it("RFC822 requests the same columns as BODY[]", () => {
      const rfc = getRequestedFields([{ type: "RFC822" }]);
      const body = getRequestedFields([
        { type: "BODY", peek: false, section: { type: "FULL" } }
      ]);
      expect([...rfc].sort()).toEqual([...body].sort());
      // sanity: full message needs text/html/headers/attachments columns.
      for (const f of ["text", "html", "subject", "from", "attachments"] as const) {
        expect(rfc.has(f)).toBe(true);
      }
    });

    it("RFC822.HEADER requests the same columns as BODY[HEADER]", () => {
      const rfc = getRequestedFields([{ type: "RFC822.HEADER" }]);
      const body = getRequestedFields([
        { type: "BODY", peek: true, section: { type: "HEADER" } }
      ]);
      expect([...rfc].sort()).toEqual([...body].sort());
      expect(rfc.has("subject")).toBe(true);
      expect(rfc.has("text")).toBe(false); // header only, no body columns
    });

    it("RFC822.TEXT requests the same columns as BODY[TEXT]", () => {
      const rfc = getRequestedFields([{ type: "RFC822.TEXT" }]);
      const body = getRequestedFields([
        { type: "BODY", peek: false, section: { type: "TEXT" } }
      ]);
      expect([...rfc].sort()).toEqual([...body].sort());
      expect(rfc.has("text")).toBe(true);
    });
  });
});

describe("buildFetchResponsePart RFC822 aliases (inbox #587)", () => {
  const mail: Partial<MailType> = {
    uid: { account: 1, domain: 1 } as MailType["uid"],
    messageId: "<test@local>",
    date: new Date("2026-06-21T00:00:00Z"),
    from: { text: "alice@example.com", value: [] } as unknown as MailType["from"],
    to: { text: "bob@example.com", value: [] } as unknown as MailType["to"],
    subject: "hello",
    text: "body line one\r\nbody line two",
    html: "",
    attachments: []
  };
  const docId = "doc-1";
  const mailbox = "INBOX";

  it("RFC822 emits the same bytes as BODY[], labelled RFC822", async () => {
    const rfc = await buildFetchResponsePart(mail, { type: "RFC822" }, docId, mailbox);
    const body = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: false, section: { type: "FULL" } },
      docId,
      mailbox
    );
    expect(rfc).not.toBeNull();
    expect(rfc!.type).toBe("literal");
    if (rfc!.type === "literal" && body!.type === "literal") {
      expect(rfc!.content).toBe(body!.content);
      expect(rfc!.length).toBe(body!.length);
      expect(rfc!.header).toBe("RFC822");
      expect(body!.header).toBe("BODY[]");
    }
  });

  it("RFC822.HEADER emits the same bytes as BODY[HEADER], labelled RFC822.HEADER", async () => {
    const rfc = await buildFetchResponsePart(mail, { type: "RFC822.HEADER" }, docId, mailbox);
    const body = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: true, section: { type: "HEADER" } },
      docId,
      mailbox
    );
    expect(rfc!.type).toBe("literal");
    if (rfc!.type === "literal" && body!.type === "literal") {
      expect(rfc!.content).toBe(body!.content);
      expect(rfc!.header).toBe("RFC822.HEADER");
    }
  });

  it("RFC822.TEXT emits the same bytes as BODY[TEXT], labelled RFC822.TEXT", async () => {
    const rfc = await buildFetchResponsePart(mail, { type: "RFC822.TEXT" }, docId, mailbox);
    const body = await buildFetchResponsePart(
      mail,
      { type: "BODY", peek: false, section: { type: "TEXT" } },
      docId,
      mailbox
    );
    expect(rfc!.type).toBe("literal");
    if (rfc!.type === "literal" && body!.type === "literal") {
      expect(rfc!.content).toBe(body!.content);
      expect(rfc!.header).toBe("RFC822.TEXT");
    }
  });
});
