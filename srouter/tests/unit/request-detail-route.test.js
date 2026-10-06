import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ byId: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/usageDb", () => ({ getRequestDetailById: mocks.byId, getRequestDetails: mocks.list }));
import { GET as getOne } from "@/app/api/usage/request-details/[id]/route.js";
import { GET as getList } from "@/app/api/usage/request-details/route.js";
const request = new Request("http://localhost/api/usage/request-details");
const params = (id) => ({ params: Promise.resolve({ id }) });
beforeEach(() => vi.resetAllMocks());

describe("Request detail metadata routes", () => {
  it("returns the same redaction from single-record and list endpoints", async () => {
    const detail = {
      id: "fixture", apiKey: "fixture-secret-api-key",
      request: { messages: ["private-prompt"] }, response: { content: "private-output" },
      provider: "fixture", tokens: { prompt_tokens: 3 },
    };
    mocks.byId.mockResolvedValue(detail);
    mocks.list.mockResolvedValue({ details: [detail], total: 1 });
    const single = await getOne(request, params("fixture"));
    const list = await getList(request);
    const oneBody = await single.json();
    expect(oneBody.detail).toEqual((await list.json()).details[0]);
    expect(single.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(oneBody)).not.toContain("private-prompt");
    expect(JSON.stringify(oneBody)).not.toContain("fixture-secret-api-key");
    expect(oneBody.detail.tokens.prompt_tokens).toBe(3);
  });
  it("returns 404 for an absent record", async () => {
    mocks.byId.mockResolvedValue(null);
    expect((await getOne(request, params("missing"))).status).toBe(404);
  });
  it.each(["", null, "x".repeat(201)])("rejects invalid id %j", async (id) => {
    expect((await getOne(request, params(id))).status).toBe(400);
    expect(mocks.byId).not.toHaveBeenCalled();
  });
  it("keeps internal DB errors out of the response", async () => {
    mocks.byId.mockRejectedValue(new Error("fixture-secret"));
    const result = await getOne(request, params("fixture"));
    expect(result.status).toBe(500);
    expect(await result.text()).not.toContain("fixture-secret");
  });
});
