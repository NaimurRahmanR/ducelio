import { it, expect, beforeEach, vi } from "vitest";
const mocks = vi.hoisted(() => ({ role: vi.fn(), rpc: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/identity", () => ({ requireAnyRole: mocks.role }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
import { AccessDenied } from "@/domain/policy";
import { runSessionOperation } from "@/app/admin/session-actions";
import {
  rescheduleClassSession,
  generateClassSessionBatch,
  listSessionOperations,
  getSessionBatchOptions,
} from "@/server/session-operations";
import {
  sessionErrorCode,
  SessionOperationError,
  batchInputSchema,
  batchOptionsInputSchema,
} from "@/domain/session-operations";
const id = "10000000-0000-4000-8000-000000000001",
  request = "10000000-0000-4000-8000-000000000002";
const reschedule = {
  sessionId: id,
  requestId: request,
  scheduledStart: "2030-01-01T18:00:00Z",
  reason: "Approved rescheduling",
};
const batch = {
  activationId: id,
  instructorId: id,
  requestId: request,
  reason: "Approved batch",
  items: [
    {
      lessonId: id,
      scheduledStart: "2030-01-01T18:00:00Z",
      scheduledEnd: "2030-01-01T19:00:00Z",
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.role.mockResolvedValue({ id });
  mocks.rpc.mockResolvedValue({
    data: {
      requestId: request,
      originalId: id,
      replay: false,
      sessionIds: [id],
    },
    error: null,
  });
});
it("reschedule sends only the authenticated narrow contract", async () => {
  await rescheduleClassSession(reschedule);
  expect(mocks.role).toHaveBeenCalledWith(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  expect(mocks.rpc).toHaveBeenCalledWith("reschedule_class_session", {
    p_session_id: id,
    p_request_id: request,
    p_scheduled_start: reschedule.scheduledStart,
    p_reason: reschedule.reason,
  });
});
it("batch sends explicit items rather than recurrence/defaults", async () => {
  await generateClassSessionBatch(batch);
  expect(mocks.rpc).toHaveBeenCalledWith("generate_class_session_batch", {
    p_request_id: request,
    p_activation_id: id,
    p_instructor_id: id,
    p_items: batch.items,
    p_reason: batch.reason,
  });
});
it.each(["role", "actorId", "instructorId", "scheduledEnd"])(
  "reschedule rejects client-supplied %s",
  async (key) => {
    await expect(
      rescheduleClassSession({ ...reschedule, [key]: id }),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
it.each(["recurrence", "repeatWeeks", "timezone", "schedulingDefaults"])(
  "batch rejects %s",
  async (key) => {
    await expect(
      generateClassSessionBatch({ ...batch, [key]: "untrusted" }),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
it.each(["reschedule", "batch", "discovery"])(
  "unauthorised caller cannot reach %s RPC",
  async (kind) => {
    mocks.role.mockRejectedValue(new Error("Denied"));
    await expect(
      kind === "reschedule"
        ? rescheduleClassSession(reschedule)
        : kind === "batch"
          ? generateClassSessionBatch(batch)
          : listSessionOperations({}),
    ).rejects.toThrow("Denied");
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
it("institutional refusals remain bounded while unknown backend messages are hidden", async () => {
  mocks.rpc.mockResolvedValue({
    data: null,
    error: { message: "COHORT_COMPLETED" },
  });
  await expect(generateClassSessionBatch(batch)).rejects.toEqual(
    new SessionOperationError("COHORT_COMPLETED"),
  );
  expect(sessionErrorCode({ message: "private SQL with credentials" })).toBe(
    "SERVICE_UNAVAILABLE",
  );
  expect(sessionErrorCode({ message: "constructor" })).toBe(
    "SERVICE_UNAVAILABLE",
  );
  expect(sessionErrorCode({ message: "toString" })).toBe("SERVICE_UNAVAILABLE");
});
it("request limit is explicit and hostile row identity is rejected", () => {
  expect(
    batchInputSchema.safeParse({
      ...batch,
      items: Array.from({ length: 101 }, () => batch.items[0]),
    }).success,
  ).toBe(false);
  expect(
    batchInputSchema.safeParse({
      ...batch,
      items: [{ ...batch.items[0], cohortId: id }],
    }).success,
  ).toBe(false);
});
it("discovery checks response bound and refuses leaked fields", async () => {
  mocks.rpc.mockResolvedValue({
    data: { hasMore: false, rows: [], secret: "unnecessary" },
    error: null,
  });
  await expect(listSessionOperations({})).rejects.toThrow();
});

function rescheduleForm() {
  const data = new FormData();
  data.set("operation", "reschedule");
  for (const [key, value] of Object.entries(reschedule)) data.set(key, value);
  return data;
}
it("action reports server role refusal truthfully without calling a mutation", async () => {
  mocks.role.mockRejectedValue(new AccessDenied());
  expect(await runSessionOperation({}, rescheduleForm())).toEqual({
    error: "Academic or Platform Admin authority is required.",
  });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("action never renders unexpected SQL or provider text", async () => {
  mocks.rpc.mockResolvedValue({
    data: null,
    error: { message: "Private internal credential exception" },
  });
  const result = await runSessionOperation({}, rescheduleForm());
  expect(result.error).toContain("Session operations are unavailable");
  expect(result.error).not.toContain("credential");
});
it("action returns the bounded institutional refusal and replay result", async () => {
  mocks.rpc.mockResolvedValueOnce({
    data: null,
    error: { message: "SESSION_STARTED" },
  });
  expect((await runSessionOperation({}, rescheduleForm())).error).toContain(
    "already started",
  );
  mocks.rpc.mockResolvedValueOnce({
    data: {
      requestId: request,
      originalId: id,
      replay: true,
      sessionIds: [id],
    },
    error: null,
  });
  expect((await runSessionOperation({}, rescheduleForm())).message).toContain(
    "Existing request confirmed",
  );
});

const emptyOptions = {
  hasMore: false,
  lessonsHasMore: false,
  activationOffset: 0,
  lessonOffset: 0,
  selectedActivation: null,
  activations: [],
  lessons: [],
};
it("first-page options default to zero offsets and an independent selected activation projection", async () => {
  mocks.rpc.mockResolvedValue({ data: emptyOptions, error: null });
  expect(await getSessionBatchOptions()).toEqual(emptyOptions);
  expect(mocks.rpc).toHaveBeenCalledWith("admin_class_session_batch_options", {
    p_activation_id: null,
    p_activation_offset: 0,
    p_lesson_offset: 0,
  });
});
it("options forward validated page offsets while retaining selection", async () => {
  mocks.rpc.mockResolvedValue({
    data: {
      ...emptyOptions,
      activationOffset: 200,
      lessonOffset: 250,
      selectedActivation: {
        id,
        instructorId: id,
        title: "Later activated course",
        status: "CLOSED",
      },
    },
    error: null,
  });
  expect(
    (
      await getSessionBatchOptions({
        activationId: id,
        activationOffset: "200",
        lessonOffset: "250",
      })
    ).selectedActivation?.id,
  ).toBe(id);
  expect(mocks.rpc).toHaveBeenCalledWith("admin_class_session_batch_options", {
    p_activation_id: id,
    p_activation_offset: 200,
    p_lesson_offset: 250,
  });
});
it.each([
  -1,
  0.5,
  2147483648,
  NaN,
  Infinity,
  "invalid",
  "1e2",
  "0x10",
  "1.5",
  "",
  null,
])(
  "option offsets reject malformed or unbounded %s before RPC",
  async (offset) => {
    await expect(
      getSessionBatchOptions({ activationOffset: offset }),
    ).rejects.toThrow();
    await expect(
      getSessionBatchOptions({ lessonOffset: offset }),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
it("option offsets accept PostgreSQL's integer transport bound without imposing a schedule count cap", () => {
  expect(
    batchOptionsInputSchema.parse({
      activationOffset: 2147483647,
      lessonOffset: 2147483647,
    }),
  ).toMatchObject({ activationOffset: 2147483647, lessonOffset: 2147483647 });
});
it("options deny an unauthorised actor and reject response pages exceeding the bound", async () => {
  mocks.role.mockRejectedValueOnce(new AccessDenied());
  await expect(getSessionBatchOptions()).rejects.toThrow();
  expect(mocks.rpc).not.toHaveBeenCalled();
  mocks.rpc.mockResolvedValue({
    data: {
      ...emptyOptions,
      lessons: Array.from({ length: 251 }, () => ({ id, title: "Lesson" })),
    },
    error: null,
  });
  await expect(getSessionBatchOptions()).rejects.toThrow();
});
