import { describe, it, expect } from "vitest";
import {
  FS_ACCEPTED_CONTRIBUTION_TYPES,
  _FS_TYPE_FALLBACKS_FOR_TEST,
} from "../future-science";

// Future Science rejects any contribution `type` outside its accepted list with
// a 4xx. Two invalid strings ("Review" and "Audit") previously leaked into the
// fallback arrays and caused silent rejections. These tests guard against any
// invalid type re-entering the fallback chains.
describe("Future Science — contribution type fallback arrays are all valid", () => {
  const accepted = new Set<string>(FS_ACCEPTED_CONTRIBUTION_TYPES);

  for (const [name, arr] of Object.entries(_FS_TYPE_FALLBACKS_FOR_TEST)) {
    it(`${name} contains only Future Science–accepted types`, () => {
      for (const t of arr) {
        expect(accepted.has(t), `"${t}" is not a Future Science accepted type`).toBe(true);
      }
    });

    it(`${name} never contains the rejected strings "Review" or "Audit"`, () => {
      expect(arr).not.toContain("Review");
      expect(arr).not.toContain("Audit");
      // Lowercase "article" is also not an accepted type (only "Article").
      expect(arr).not.toContain("article");
    });

    it(`${name} has no duplicate entries`, () => {
      expect(new Set(arr).size).toBe(arr.length);
    });
  }

  it("literature reviews lead with the valid 'Literature review' type", () => {
    expect(_FS_TYPE_FALLBACKS_FOR_TEST.literatureReview[0]).toBe("Literature review");
  });

  it("peer reviews lead with the valid 'Peer-review' type", () => {
    expect(_FS_TYPE_FALLBACKS_FOR_TEST.peerReview[0]).toBe("Peer-review");
  });

  it("single-paper (response-style) ethics audits lead with 'Response to a contribution'", () => {
    expect(_FS_TYPE_FALLBACKS_FOR_TEST.ethicsResponse[0]).toBe("Response to a contribution");
  });

  it("aggregate (field) ethics reports lead with a valid review-style type", () => {
    expect(accepted.has(_FS_TYPE_FALLBACKS_FOR_TEST.ethicsField[0])).toBe(true);
    expect(_FS_TYPE_FALLBACKS_FOR_TEST.ethicsField[0]).not.toBe("Audit");
  });
});
