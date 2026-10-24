import { describe, expect, it } from "vitest";
import {
  callHostedRpc,
  describeRpcError,
  TRANSPORT_RETRY_SAFE_RPCS,
} from "../scripts/acceptance/hosted-rpc.mjs";

type Reply = { data?: unknown; error?: unknown; status: number };
// The exact shape postgrest-js 2.116 returns when fetch throws.
const transport = (cause = "UND_ERR_SOCKET"): Reply => ({
  error: {
    message: "TypeError: fetch failed",
    details: `TypeError: fetch failed\n\nCaused by: SocketError: other side closed (${cause})\n    at secret-stack-frame`,
    hint: "",
    code: "",
  },
  status: 0,
});

function client(replies: Reply[]) {
  const calls: string[] = [];
  return {
    calls,
    rpc: async (name: string) => {
      calls.push(name);
      const next = replies.shift();
      if (!next) throw new Error("unexpected call");
      return { data: null, error: null, ...next };
    },
  };
}
const noSleep = { sleep: async () => {} };

describe("hosted acceptance RPC caller", () => {
  it("retries a transport failure of a server-idempotent start and reports it", async () => {
    const c = client([transport(), { data: { ok: true }, status: 200 }]);
    const retries: unknown[] = [];
    await expect(
      callHostedRpc(
        c,
        "start_my_academy_assessment",
        {},
        {
          ...noSleep,
          onRetry: (r: unknown) => retries.push(r),
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(c.calls).toHaveLength(2);
    expect(retries).toEqual([
      {
        name: "start_my_academy_assessment",
        attempt: 1,
        reason: "TRANSPORT_FAILURE(UND_ERR_SOCKET)",
      },
    ]);
  });

  it("bounds retries and then names the transport cause, never details", async () => {
    const c = client([transport(), transport(), transport("ECONNRESET")]);
    const failure = callHostedRpc(c, "record_my_academy_response", {}, noSleep);
    await expect(failure).rejects.toThrow(
      /^record_my_academy_response: TRANSPORT_FAILURE\(ECONNRESET\)$/,
    );
    expect(c.calls).toHaveLength(3);
  });

  it("never retries RPCs whose concurrency or replay is under test", async () => {
    for (const name of [
      "create_unified_course_order",
      "confirm_my_academy_schedule",
      "create_organisation_course_coupon",
      "publish_unified_course",
    ]) {
      expect(TRANSPORT_RETRY_SAFE_RPCS.has(name)).toBe(false);
      const c = client([transport()]);
      await expect(callHostedRpc(c, name, {}, noSleep)).rejects.toThrow(
        `${name}: TRANSPORT_FAILURE(UND_ERR_SOCKET)`,
      );
      expect(c.calls).toHaveLength(1);
    }
  });

  it("never retries a real server refusal", async () => {
    const c = client([
      {
        error: { message: "NOT_FOUND_OR_FORBIDDEN", code: "P0001" },
        status: 400,
      },
    ]);
    await expect(
      callHostedRpc(c, "get_my_academy_timetable", {}, noSleep),
    ).rejects.toThrow("get_my_academy_timetable: NOT_FOUND_OR_FORBIDDEN");
    expect(c.calls).toHaveLength(1);
  });

  it("keeps every error description bounded", () => {
    expect(
      describeRpcError(403, {
        message: "permission denied for table academy_orders",
        code: "42501",
      }),
    ).toBe("42501");
    expect(
      describeRpcError(401, { message: "JWT expired", code: "PGRST301" }),
    ).toBe("PGRST301");
    expect(
      describeRpcError(502, { message: "<html>learner@example.test</html>" }),
    ).toBe("HTTP_502");
    expect(
      describeRpcError(0, {
        message: "TypeError: fetch failed",
        details: "",
        code: "",
      }),
    ).toBe("TRANSPORT_FAILURE");
  });
});
