import { expect, it } from "vitest";
import { safeResponseMetadata, responseFailureSuffix } from "../request-failure";

it("allowlists response diagnostics rather than copying headers, bodies or arbitrary values", () => {
  expect(safeResponseMetadata({
    httpStatus: 200, mediaType: "json", jsonRead: "invalid",
    headers: "PRIVATE", body: "PRIVATE", requestId: "PRIVATE",
  })).toEqual({ httpStatus: 200, mediaType: "json", jsonRead: "invalid" });
  expect(responseFailureSuffix({
    httpStatus: 999, mediaType: "PRIVATE", jsonRead: "PRIVATE",
  })).toBe("");
});
