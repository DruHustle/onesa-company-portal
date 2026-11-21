import type { operations } from "@/lib/api/generated/schema";
type Content =
  operations["createContent"]["responses"][201]["content"]["application/json"];
export function PublicationSummary({
  content,
  dirty,
  publisher,
}: {
  content: Content;
  dirty: boolean;
  publisher: boolean;
}) {
  const publication = content.publication;
  if (!publication)
    return (
      <section className="admin-card" aria-label="Publication status">
        <h2>Publication status</h2>
        <p>
          Live-edition details are unavailable. Reload this record after the
          compatible API is available; do not infer publication from the working
          draft.
        </p>
      </section>
    );
  const {
    live,
    everPublished,
    hasUnpublishedChanges,
    scheduledAt,
    scheduledRevision,
  } = publication;
  const review = content.metadata.editorialReview;
  const approved =
    review?.status === "approved" &&
    review.reviewedRevision === content.revision;
  const title = scheduledAt
    ? live
      ? "Replacement scheduled"
      : "Publication scheduled"
    : live
      ? hasUnpublishedChanges || content.state === "draft"
        ? "Live edition and replacement draft"
        : "Published — no pending content changes"
      : everPublished
        ? "Unpublished — draft retained"
        : "Never published";
  const sections = {
    product: "products",
    article: "news",
    job: "careers",
    research: "research",
  };
  const livePath = live
    ? `/${live.locale}` +
      (live.kind === "page" || live.kind === "section"
        ? live.slug === "home"
          ? ""
          : `/${encodeURIComponent(live.slug)}`
        : `/${sections[live.kind]}/${encodeURIComponent(live.slug)}`)
    : null;
  const next = dirty
    ? "Save the working changes before review or publication."
    : scheduledAt
      ? `The approved revision ${scheduledRevision} is scheduled. The current live edition remains in place until publication.`
      : live && !hasUnpublishedChanges && content.state === "published"
        ? "Edit and save a replacement draft when you need to change the live edition."
        : approved
          ? publisher
            ? "Publish this reviewed revision, or choose a publication time."
            : "Ask a publisher to release this approved revision."
          : publisher
            ? "Review the saved working revision before publication."
            : review?.status === "pending_review"
              ? "Await a publisher’s review; edits will require a new review."
              : "Save the draft and submit its exact revision for review.";
  return (
    <section
      className="admin-card publication-summary"
      aria-label="Publication status"
    >
      <h2>{title}</h2>
      <dl>
        <div>
          <dt>Live edition</dt>
          <dd>
            {live ? (
              <>
                <strong>Revision {live.revision}</strong> · {live.title}{" "}
                <a href={livePath!} target="_blank" rel="noopener">
                  View live edition
                </a>
              </>
            ) : everPublished ? (
              "Offline. No edition is currently public."
            ) : (
              "None. This content has never been published."
            )}
          </dd>
        </div>
        <div>
          <dt>Working draft</dt>
          <dd>
            Revision {content.revision} · {content.state}
            {dirty ? " · Unsaved changes" : ""}
          </dd>
        </div>
        <div>
          <dt>Editorial review</dt>
          <dd>
            {approved
              ? `Approved for revision ${content.revision}`
              : review?.status === "pending_review"
                ? "Awaiting review"
                : review?.status === "needs_changes"
                  ? "Changes requested"
                  : "Not approved for this revision"}
          </dd>
        </div>
        <div>
          <dt>Scheduled replacement</dt>
          <dd>
            {scheduledAt
              ? `${new Date(scheduledAt).toLocaleString()} · revision ${scheduledRevision}`
              : "None approved and scheduled"}
          </dd>
        </div>
      </dl>
      {live && (dirty || hasUnpublishedChanges) && (
        <p>
          The live edition remains unchanged while you edit this replacement.
        </p>
      )}
      <p>
        <strong>Next action:</strong> {next}
      </p>
    </section>
  );
}
