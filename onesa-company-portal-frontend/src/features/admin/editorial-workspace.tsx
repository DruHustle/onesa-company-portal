"use client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import {PublicationSummary} from "./publication-summary";
import type { operations } from "@/lib/api/generated/schema";
type Content =
  operations["createContent"]["responses"][201]["content"]["application/json"];
type Media =
  operations["listEditorialMedia"]["responses"][200]["content"]["application/json"]["items"][number];
type Revision =
  operations["contentRevisions"]["responses"][200]["content"]["application/json"]["items"][number];
type Props = {
  draftDirty:boolean;
  items: Content[];
  role: string;
  busy: boolean;
  refresh: () => Promise<void>;
  navigate: (action: () => void) => void;
  perform: (action: () => Promise<void>, success?: string) => Promise<void>;
  submitted: (
    action: (data: FormData) => Promise<void>,
  ) => (event: FormEvent<HTMLFormElement>) => void;
};
const text = (data: FormData, key: string) => String(data.get(key) || "");
function Field({
  label,
  name,
  initial = "",
  required = false,
}: {
  label: string;
  name: string;
  initial?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input name={name} defaultValue={initial} required={required} />
    </label>
  );
}
function MediaPicker({ initial }: { initial?: string }) {
  const [items, setItems] = useState<Media[]>([]),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(initial || ""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api
        .GET("/api/v1/admin/content/media", {
          params: { query: { search: query, limit: 100 } },
          signal: controller.signal,
        })
        .then((r) => {
          if (!controller.signal.aborted) setItems(r.data!.items);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("Approved media could not be loaded. Retry the search.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  const media = items.find((item) => item.id === selected);
  return (
    <fieldset>
      <legend>Public image</legend>
      <label>
        Find approved media
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p role="status">
        {loading
          ? "Loading approved images…"
          : error ||
            (!items.length
              ? "No approved images match. Upload and approve an image in Media first."
              : "Only approved, clean public images are available.")}
      </p>
      <label>
        Image
        <select
          aria-label="Approved public image"
          name="imageId"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">No image</option>
          {initial && !items.some((item) => item.id === initial) && (
            <option value={initial}>
              Current image — verify availability before publication
            </option>
          )}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title} · {item.filename} · version {item.version}
            </option>
          ))}
        </select>
      </label>
      {media && (
        <figure>
          <img
            src={`/api/v1/public/files/${media.id}/download`}
            alt={`Selected media preview: ${media.title}`}
            style={{ maxWidth: "100%", maxHeight: 220, objectFit: "contain" }}
          />
          <figcaption>
            {media.title}. Record the image’s alt text and rights/source below;
            approval does not supply these.
          </figcaption>
        </figure>
      )}
    </fieldset>
  );
}
export function EditorialWorkspace({
  items,
  draftDirty,
  role,
  busy,
  refresh,
  navigate,
  perform,
  submitted,
}: Props) {
  const [content, setContent] = useState<Content | null>(null),
    [revisions, setRevisions] = useState<Revision[]>([]),[selection,setSelection]=useState(0);
  const draftHeading=useRef<HTMLHeadingElement|null>(null),previewHeading=useRef<HTMLHeadingElement|null>(null),pendingFocus=useRef<'draft'|'preview'|null>(null);
  useLayoutEffect(()=>{const target=pendingFocus.current==='draft'?draftHeading.current:pendingFocus.current==='preview'?previewHeading.current:null;if(target){pendingFocus.current=null;target.focus();}},[content?.id,content?.revision,selection]);
  const publisher = role === "owner" || role === "administrator",
    approved =
      content?.metadata.editorialReview?.status === "approved" &&
      content.metadata.editorialReview.reviewedRevision === content.revision;
  function choose(item: Content | null) {
    navigate(() => {
      pendingFocus.current='draft';setSelection(value=>value+1);setContent(item);
      setRevisions([]);
    });
  }
  return (
    <section aria-label="Website editorial workspace">
      <p>Edit → Save draft → Preview → Submit for review → Approve → Publish</p>
      <p>
        Saving a draft keeps the last published edition online. Only an owner or
        administrator can approve, schedule, publish or unpublish.
      </p>
      <div className="admin-grid">
        <div className="admin-list">
          <button disabled={busy} onClick={() => choose(null)}>
            New content
          </button>
          {!items.length && <p>No content in this queue.</p>}
          {items.map((item) => (
            <button
              key={item.id}
              disabled={busy}
              aria-pressed={content?.id === item.id}
              onClick={() => choose(item)}
            >
              {item.title}
              <small>
                {item.kind} · {item.locale.toUpperCase()} · working r{item.revision}
                {item.publication?.live?` · live r${item.publication.live.revision}`:item.publication?.everPublished?" · unpublished":" · no live edition"}
              </small>
            </button>
          ))}
        </div>
        <div>
          {content&&<PublicationSummary content={content} dirty={draftDirty} publisher={publisher}/>}
          <form
            data-editorial-draft
            data-workspace-draft
            key={content ? `${content.id}-${content.revision}` : `new-${selection}`}
            className="admin-card"
            onSubmit={submitted(async (data) => {
              const body = {
                kind: text(data, "kind") as Content["kind"],
                locale: text(data, "locale") as Content["locale"],
                slug: text(data, "slug"),
                title: text(data, "title"),
                summary: text(data, "summary"),
                body: text(data, "body"),
                state: "draft" as const,
                publishAt: null,
                metadata: {
                  category: text(data, "category"),
                  author: text(data, "author"),
                  imageId: text(data, "imageId") || undefined,
                  imageAlt: text(data, "imageAlt") || undefined,
                  imageRights: text(data, "imageRights") || undefined,
                  imageCaption: text(data, "imageCaption") || undefined,
                  imageCredit: text(data, "imageCredit") || undefined,
                  seoTitle: text(data, "seoTitle"),
                  seoDescription: text(data, "seoDescription"),
                  featured: data.get("featured") === "on",
                },
              };
              const response = content
                ? await api.PATCH("/api/v1/admin/content/{id}", {
                    params: { path: { id: content.id } },
                    body: { ...body, revision: content.revision },
                  })
                : await api.POST("/api/v1/admin/content", { body });
              pendingFocus.current='preview';setContent(response.data!);
              await refresh();
            })}
          >
            <h2 ref={draftHeading} tabIndex={-1}>{content ? "Edit working draft" : "Create a draft"}</h2>
            <fieldset disabled={busy}>
              <legend>Content and audience</legend>
              <label>
                Type
                <select aria-label="Type" name="kind" defaultValue={content?.kind || "article"}>
                  {[
                    ["article", "News article"],
                    ["page", "Page"],
                    ["product", "Product"],
                    ["job", "Vacancy"],
                    ["research", "Research"],
                    ["section", "Section copy"],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Language
                <select aria-label="Language" name="locale" defaultValue={content?.locale || "en"}>
                  <option value="en">English</option>
                  <option value="de">Deutsch</option>
                </select>
              </label>
              <Field
                label="URL slug"
                name="slug"
                initial={content?.slug}
                required
              />
              <Field
                label="Title"
                name="title"
                initial={content?.title}
                required
              />
              <label>
                Summary
                <textarea name="summary" defaultValue={content?.summary} />
              </label>
              <label>
                Body — plain text, with blank lines between paragraphs
                <textarea name="body" rows={12} defaultValue={content?.body} />
              </label>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>Story details</legend>
              <Field
                label="Category (optional)"
                name="category"
                initial={content?.metadata.category}
              />
              <Field
                label="Author (optional)"
                name="author"
                initial={content?.metadata.author}
              />
              <MediaPicker
                key={content ? `${content.id}-${content.revision}` : `new-${selection}`}
                initial={content?.metadata.imageId}
              />
              <Field
                label="Image alt text"
                name="imageAlt"
                initial={content?.metadata.imageAlt}
              />
              <Field
                label="Image rights and source — public-safe"
                name="imageRights"
                initial={content?.metadata.imageRights}
              />
              <Field
                label="Image caption (optional)"
                name="imageCaption"
                initial={content?.metadata.imageCaption}
              />
              <Field
                label="Image credit (optional)"
                name="imageCredit"
                initial={content?.metadata.imageCredit}
              />
              <label className="check">
                <input
                  type="checkbox"
                  name="featured"
                  defaultChecked={content?.metadata.featured}
                />
                Featured story
              </label>
              <details>
                <summary>Search appearance</summary>
                <Field
                  label="SEO title (optional)"
                  name="seoTitle"
                  initial={content?.metadata.seoTitle}
                />
                <Field
                  label="SEO description (optional)"
                  name="seoDescription"
                  initial={content?.metadata.seoDescription}
                />
              </details>
              <button className="button" disabled={busy}>
                Save draft
              </button>
            </fieldset>
          </form>
          {content && (
            <>
              <section className="admin-card" aria-label="Saved draft preview">
                <h2 ref={previewHeading} tabIndex={-1}>Saved draft preview</h2>
                <p>
                  Revision {content.revision} ·{" "}
                  {content.metadata.editorialReview?.status.replaceAll(
                    "_",
                    " ",
                  ) || "Draft"}
                </p>
                <h3>{content.title}</h3>
                <p>{content.summary}</p>
                <div className="prose" style={{ whiteSpace: "pre-wrap" }}>
                  {content.body}
                </div>
                {content.metadata.imageId && (
                  <p>
                    Alt text: {content.metadata.imageAlt || "Required"}
                    <br />
                    Rights/source: {content.metadata.imageRights || "Required"}
                  </p>
                )}
              </section>
              <form
                data-workspace-draft
                key={`review-${content.id}-${content.revision}`}
                className="admin-card"
                onSubmit={submitted(async (data) => {
                  const response = await api.POST(
                    "/api/v1/admin/content/{id}/review",
                    {
                      params: { path: { id: content.id } },
                      body: {
                        expectedRevision: content.revision,
                        verdict: text(data, "verdict") as
                          "pending_review" | "approved" | "needs_changes",
                        note: text(data, "note"),
                      },
                    },
                  );
                  pendingFocus.current='preview';setContent(response.data!);
                  await refresh();
                })}
              >
                <h2>
                  {publisher
                    ? "Review the saved revision"
                    : "Submit for review"}
                </h2>
                <p>
                  Review is bound to revision {content.revision}. Any text or
                  media edit requires a new approval.
                </p>
                <fieldset disabled={busy||draftDirty}>
                  <legend>Editorial decision</legend>
                  <label>
                    Next action
                    <select name="verdict">
                      <option value="pending_review">Submit for review</option>
                      {publisher && (
                        <>
                          <option value="approved">
                            Approve this revision
                          </option>
                          <option value="needs_changes">Request changes</option>
                        </>
                      )}
                    </select>
                  </label>
                  <label>
                    Review note
                    <textarea
                      name="note"
                      minLength={10}
                      maxLength={4000}
                      required
                    />
                  </label>
                  <button className="button" disabled={busy}>
                    {publisher
                      ? "Record review decision"
                      : "Submit saved draft for review"}
                  </button>
                </fieldset>
              </form>
              {publisher && (
                <form
                  data-workspace-draft
                  key={`publication-${content.id}-${content.revision}`}
                  className="admin-card"
                  onSubmit={submitted(async (data) => {
                    const {
                      publishedAt: _,
                      editorialReview: __,
                      ...metadata
                    } = content.metadata;
                    void _;
                    void __;
                    const scheduled = text(data, "publishAt");
                    const response = await api.PATCH(
                      "/api/v1/admin/content/{id}",
                      {
                        params: { path: { id: content.id } },
                        body: {
                          kind: content.kind,
                          locale: content.locale,
                          slug: content.slug,
                          title: content.title,
                          summary: content.summary,
                          body: content.body,
                          metadata,
                          state: "published",
                          revision: content.revision,
                          publishAt: scheduled
                            ? new Date(scheduled).toISOString()
                            : null,
                        },
                      },
                    );
                    pendingFocus.current='preview';setContent(response.data!);
                    await refresh();
                  })}
                >
                  <h2>Publish approved revision</h2>{draftDirty&&<p>Save the working draft before reviewing or publishing. The public edition remains unchanged.</p>}
                  <p>
                    {approved
                      ? "This saved revision is approved. Publication replaces the public edition."
                      : "Approve the saved revision before publishing."}
                  </p>
                  <label>
                    Schedule (optional, your local time)
                    <input name="publishAt" type="datetime-local" />
                  </label>
                  <button className="button" disabled={busy || draftDirty || !approved}>
                    Publish or schedule this revision
                  </button>
                  {content.publication?.live&&<button
                    type="button"
                    disabled={busy||draftDirty}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Unpublish “${content.title}” (${content.locale.toUpperCase()})? The public edition will be removed. The working draft and revision history remain.`,
                        )
                      )
                        return;
                      void perform(async () => {
                        const response = await api.POST(
                          "/api/v1/admin/content/{id}/unpublish",
                          {
                            params: { path: { id: content.id } },
                            body: { expectedRevision: content.revision },
                          },
                        );
                        pendingFocus.current='preview';setContent(response.data!);
                        await refresh();
                      }, "Public edition removed; draft retained");
                    }}
                  >
                    Unpublish
                  </button>}
                </form>
              )}
              <details className="admin-card">
                <summary>Revision history and technical details</summary>
                <p>Content reference: {content.id}</p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const response = await api.GET(
                        "/api/v1/admin/content/{id}/revisions",
                        {
                          params: {
                            path: { id: content.id },
                            query: { limit: 100 },
                          },
                        },
                      );
                      setRevisions(response.data!.items);
                    }, "Revision history loaded")
                  }
                >
                  Load revisions
                </button>
                {revisions.map((revision) => (
                  <div className="admin-actions" key={revision.id}>
                    <span>
                      Revision {revision.snapshot.revision} ·{" "}
                      {revision.created_at}
                    </span>
                    <button
                      disabled={busy}
                      onClick={() =>
                        navigate(() => {
                          void perform(async () => {
                            const response = await api.POST(
                              "/api/v1/admin/content/{id}/restore",
                              {
                                params: { path: { id: content.id } },
                                body: {
                                  revisionId: revision.id,
                                  currentRevision: content.revision,
                                },
                              },
                            );
                            pendingFocus.current='preview';setContent(response.data!);
                            setRevisions([]);
                            await refresh();
                          }, "Restored as a working draft; public edition preserved");
                        })
                      }
                    >
                      Restore as draft
                    </button>
                  </div>
                ))}
              </details>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
