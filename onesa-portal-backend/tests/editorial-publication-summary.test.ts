import "./local-environment.js";
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL =
  "postgresql://summary:synthetic@127.0.0.1:1/summary_test";
process.env.SESSION_KEY = "summary-tests-only-not-a-production-key-1234567890";
const { describeEditorialPublication, editorialDigest } =
  await import("../src/services/editorial.js");
const { publicContent } = await import("../src/api/contracts.js");
const now = Date.parse("2026-10-19T12:00:00Z");
const row = {
  id: "7a927fd9-a328-4c54-b27d-f4989f5840af",
  kind: "article",
  slug: "synthetic-edition",
  locale: "en",
  title: "Public title",
  summary: "Public summary",
  body: "Public body",
  metadata: {},
  revision: 1,
  state: "draft",
  publish_at: null,
};
test("never published and explicitly unpublished are distinguishable without exposing audit detail", () => {
  assert.deepEqual(describeEditorialPublication(row, false, now), {
    live: null,
    everPublished: false,
    hasUnpublishedChanges: true,
    scheduledAt: null,
    scheduledRevision: null,
  });
  assert.deepEqual(
    describeEditorialPublication({ ...row, revision: 4 }, true, now),
    {
      live: null,
      everPublished: true,
      hasUnpublishedChanges: true,
      scheduledAt: null,
      scheduledRevision: null,
    },
  );
});
test("current publication and replacement draft keep distinct live identity", () => {
  const live = {
    ...row,
    state: "published",
    metadata: { publishedAt: "2026-10-18T12:00:00Z" },
  };
  assert.equal(
    describeEditorialPublication(
      { ...live, published_snapshot: live },
      false,
      now,
    ).hasUnpublishedChanges,
    false,
  );
  const result = describeEditorialPublication(
    {
      ...row,
      title: "Private replacement",
      body: "Private replacement body",
      revision: 2,
      published_snapshot: live,
    },
    false,
    now,
  );
  assert.equal(result.live?.revision, 1);
  assert.equal(result.live?.title, "Public title");
  assert.equal(result.hasUnpublishedChanges, true);
  assert.ok(!JSON.stringify(result).includes("Private replacement"));
  assert.ok(!JSON.stringify(result).includes("Public body"));
});
test("private review notes alone do not invent a public replacement", () => {
  const live = { ...row, state: "published" };
  const current = {
    ...live,
    revision: 2,
    metadata: { editorialReview: { note: "Private review only" } },
  };
  assert.equal(
    describeEditorialPublication(
      { ...current, published_snapshot: live },
      false,
      now,
    ).hasUnpublishedChanges,
    false,
  );
});
test("schedule requires exact approved revision and digest", () => {
  const candidate = {
    ...row,
    revision: 3,
    title: "Scheduled replacement",
    publish_at: "2026-10-20T12:00:00Z",
  };
  const metadata = {
    editorialReview: {
      status: "approved",
      reviewedRevision: 3,
      sourceRevision: 2,
      digest: editorialDigest(candidate),
      reviewedBy: "123e4567-e89b-42d3-a456-426614174000",
      reviewedAt: "2026-10-19T11:00:00Z",
      note: "Synthetic review",
    },
  };
  const approved = {
    ...candidate,
    metadata,
    published_snapshot: { ...row, state: "published" },
  };
  const result = describeEditorialPublication(approved, false, now);
  assert.equal(result.live?.revision, 1);
  assert.equal(result.scheduledRevision, 3);
  assert.equal(
    result.scheduledAt,
    new Date(candidate.publish_at).toISOString(),
  );
  assert.equal(
    describeEditorialPublication({ ...approved, revision: 4 }, false, now)
      .scheduledAt,
    null,
  );
  assert.equal(
    describeEditorialPublication(
      { ...approved, body: "Changed after review" },
      false,
      now,
    ).scheduledAt,
    null,
  );
  assert.equal(
    describeEditorialPublication({ ...candidate, metadata: {} }, false, now)
      .scheduledAt,
    null,
  );
});
test("future-only legacy publication is neither currently live nor previously published", () => {
  const legacy = {...row, state: "published", publish_at: "2026-10-20T12:00:00Z"};
  const pending = describeEditorialPublication(legacy, false, now);
  assert.equal(pending.live, null); assert.equal(pending.everPublished, false);
  assert.equal(describeEditorialPublication({...legacy, published_snapshot: legacy}, false, now).everPublished, false);
});
test("public content contract strips protected publication and review metadata", () => {
  const result = publicContent.parse({
    ...row,
    state: "published",
    author_id: null,
    updated_at: "2026-10-19T12:00:00Z",
    publication: describeEditorialPublication(row),
    published_snapshot: { ...row, body: "Private snapshot field" },
    metadata: { editorialReview: { note: "Private review" } },
  });
  for (const key of [
    "publication",
    "published_snapshot",
    "revision",
    "state",
    "author_id",
  ])
    assert.equal(key in result, false, key);
  assert.equal("editorialReview" in result.metadata, false);
});
