import { describe, expect, it } from "vitest";
import { sslFor } from "./client.js";

describe("Tiger TLS policy", () => {
  it("verifies Tiger Cloud against the bundled CA", () => {
    const ssl = sslFor("postgres://u:p@abc.tsdb.cloud.timescale.com:5432/tsdb?sslmode=require") as { ca?: string; rejectUnauthorized?: boolean };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain("BEGIN CERTIFICATE");
  });

  it("uses verified TLS for any other remote host, even without sslmode", () => {
    expect(sslFor("postgres://u:p@db.example.com:5432/x")).toEqual({ rejectUnauthorized: true });
  });

  it("allows plaintext only for localhost or an explicit sslmode=disable", () => {
    expect(sslFor("postgres://u:p@localhost:55432/postgres")).toBeUndefined();
    expect(sslFor("postgres://u:p@127.0.0.1:55432/postgres")).toBeUndefined();
    expect(sslFor("postgres://u:p@db.example.com/x?sslmode=disable")).toBeUndefined();
    expect(sslFor("postgres://u:p@localhost/x?sslmode=require")).toEqual({ rejectUnauthorized: true });
  });
});
