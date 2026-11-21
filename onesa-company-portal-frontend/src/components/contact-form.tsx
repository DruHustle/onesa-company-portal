"use client";
import { useRef, useState, type FormEvent } from "react";
import { ResponsiveLink as Link } from "@/components/responsive-link";
import { api, ApiError } from "@/lib/api/client";
import { copy, type Locale } from "@/config/copy";
import { company } from "@/config/company";
import {
  enquiryTopics,
  enquiryTopic,
  type EnquiryTopic,
} from "@/config/enquiry-topics";
import type { paths } from "@/lib/api/generated/schema";
type Body =
  paths["/api/v1/public/enquiries"]["post"]["requestBody"]["content"]["application/json"];
export function ContactForm({
  locale,
  category = "general",
  topic,
}: {
  locale: Locale;
  category?: Body["category"];
  topic?: EnquiryTopic;
}) {
  const t = copy[locale].form,
    de = locale === "de";
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState(""),
    [saved, setSaved] = useState(false),
    [reference, setReference] = useState(""),
    [invalid, setInvalid] = useState(false);
  const sending = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setSaved(false);
    setReference("");
    setMessage("");
    setInvalid(false);
    const form = event.currentTarget,
      data = new FormData(form),
      selected = enquiryTopic(data.get("topic")),
      body = String(data.get("message")),
      prefix = selected
        ? `${de ? "Thema" : "Topic"}: ${enquiryTopics[selected][locale]}\n\n`
        : "";
    try {
      if (prefix.length + body.length > 10000) {
        setInvalid(true);
        setMessage(
          de
            ? "Bitte kürzen Sie Ihre Nachricht einschließlich Themenangabe auf 10.000 Zeichen."
            : "Please shorten your message, including the topic, to 10,000 characters.",
        );
        return;
      }
      const response = await api.POST("/api/v1/public/enquiries", {
        body: {
          category: data.get("category") as Body["category"],
          name: String(data.get("name")),
          email: String(data.get("email")),
          organization: String(data.get("organization")),
          message: prefix + body,
          locale,
          consent: true,
          website: String(data.get("website") || ""),
        },
      });
      setSaved(true);
      setReference(response.data!.id);
      setMessage(t.saved);
      form.reset();
    } catch (error) {
      setSaved(false);
      setInvalid(false);
      setMessage(
        error instanceof ApiError
          ? `${t.error} (${error.requestId || error.status})`
          : t.error,
      );
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return (
    <form className="contact-form" onSubmit={submit} aria-busy={pending}>
      <fieldset disabled={pending}>
        <legend>{de ? "Ihre Anfrage" : "Your enquiry"}</legend>
        {topic && (
          <p>
            {de ? "Ausgewähltes Thema" : "Selected topic"}:{" "}
            <strong>{enquiryTopics[topic][locale]}</strong>
          </p>
        )}
        <div className="form-grid">
          <label>
            {t.name}
            <input
              name="name"
              required
              minLength={2}
              maxLength={150}
              autoComplete="name"
            />
          </label>
          <label>
            {t.email}
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
            />
          </label>
        </div>
        <label>
          {t.organization} ({de ? "optional" : "optional"})
          <input
            name="organization"
            maxLength={200}
            autoComplete="organization"
          />
        </label>
        <label>
          {t.category}
          <select
            name="category"
            defaultValue={topic ? enquiryTopics[topic].category : category}
          >
            {(
              [
                "general",
                "enterprise",
                "partnership",
                "research",
                "media",
              ] as const
            ).map((value, index) => (
              <option key={value} value={value}>
                {
                  (de
                    ? [
                        "Allgemeine Anfrage",
                        "Unternehmenslösungen",
                        "Partnerschaft",
                        "Forschungskooperation",
                        "Presseanfrage",
                      ]
                    : [
                        "General enquiry",
                        "Enterprise solutions",
                        "Partnership",
                        "Research collaboration",
                        "Media enquiry",
                      ])[index]
                }
              </option>
            ))}
          </select>
        </label>
        <label>
          {de ? "Thema (optional)" : "Topic (optional)"}
          <select name="topic" defaultValue={topic || ""}>
            <option value="">
              {de ? "Kein bestimmtes Thema" : "No specific topic"}
            </option>
            {Object.entries(enquiryTopics).map(([id, item]) => (
              <option value={id} key={id}>
                {item[locale]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.message}
          <textarea
            name="message"
            required
            minLength={10}
            maxLength={9900}
            rows={6}
            aria-describedby="contact-message-help contact-feedback"
            aria-invalid={invalid || undefined}
          />
        </label>
        <p id="contact-message-help">
          {de
            ? "Beschreiben Sie Ihr Ziel und die Informationen, die Sie benötigen. Pflichtfelder sind Name, E-Mail und Nachricht."
            : "Describe your goal and the information you need. Name, email and message are required."}
        </p>
        <label className="honeypot" aria-hidden="true">
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
        <label className="check">
          <input name="consent" type="checkbox" required />
          {t.consent}
        </label>
        <Link href={`/${locale}/privacy`}>
          {de ? "Datenschutzhinweise lesen" : "Read privacy information"}
        </Link>
        <button className="button" disabled={pending}>
          {pending ? t.sending : t.send}
        </button>
      </fieldset>
      <div id="contact-feedback" role={saved ? "status" : "alert"}>
        <p>{message}</p>
        {reference && saved && (
          <p>
            {de ? "Referenz" : "Reference"}: <strong>{reference}</strong>
            <br />
            {de
              ? "Dies bestätigt die Speicherung, nicht die E-Mail-Zustellung."
              : "This confirms that your enquiry was saved, not that an email was delivered."}
          </p>
        )}
      </div>
      {message && !saved && (
        <p>
          {de
            ? "Alternativ erreichen Sie uns unter"
            : "You can also contact us at"}{" "}
          <a href={`mailto:${company.email}`}>{company.email}</a>.
        </p>
      )}
    </form>
  );
}
