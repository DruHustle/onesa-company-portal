import type { Locale } from "@/config/copy";
import { company } from "@/config/company";
import { ResponsiveLink as Link } from "./responsive-link";
import styles from "./company-story.module.css";

export function CompanyStory({ locale }: { locale: Locale }) {
  const de = locale === "de";
  return (
    <div className={styles.story}>
      <section>
        <p className="eyebrow">ONESA UG · HEIDELBERG</p>
        <h2>
          {de ? "Warum wir Onesa entwickeln" : "Why we are building Onesa"}
        </h2>
        <p>
          {de
            ? "Onesa wurde 2026 gegründet und hat seinen Sitz in Heidelberg. Wir entwickeln eine gemeinsame KI-Grundlage für Anwendungen in unterschiedlichen Branchen und für künftige intelligente Maschinen."
            : "Founded in 2026 and based in Heidelberg, Onesa is developing a shared AI foundation for applications across industries and future intelligent machines."}
        </p>
        <p>
          {de
            ? "Wissen ist am nützlichsten, wenn daraus ein verständlicher nächster Schritt wird. Onesa verbindet Software, KI und Daten, damit Menschen Informationen in einem zusammenhängenden Arbeitsablauf nutzen können."
            : "Knowledge is most useful when it leads to a clear next step. Onesa brings software, AI and data together so people can use information within a connected workflow."}
        </p>
        <p>
          {de
            ? "Unser Ausgangspunkt ist praktische Software: klare Oberflächen, geschützte Arbeitsbereiche und nachvollziehbare Ergebnisse. Wir entwickeln aus Heidelberg für Menschen und Organisationen in Europa und darüber hinaus."
            : "Our starting point is practical software: clear interfaces, protected workspaces and results people can examine. We develop from Heidelberg for people and organizations in Europe and beyond."}
        </p>
      </section>
      <section>
        <h2>
          {de ? "Woran wir heute arbeiten" : "What we are working on today"}
        </h2>
        <p>
          {de
            ? "Unser Hauptprodukt ist die Onesa AI Platform. Sie verbindet Gespräche, eigenes Wissen und geführte Abläufe. Die Software befindet sich in der Entwicklung; verfügbare Funktionen werden im geschützten Arbeitsbereich und in der Produktdokumentation beschrieben."
            : "Our primary product is Onesa AI Platform, connecting conversations, your knowledge and guided workflows. The software is under development; the protected workspace and product documentation describe its available functions."}
        </p>
        <p>
          {de
            ? "Onesa AI Robot ist eine separate Entwicklungslinie. Der heutige Schwerpunkt liegt auf geschützter Simulator-Software. Die Integration physischer Hardware ist ein weiterer Entwicklungsschritt."
            : "Onesa AI Robot is a separate development line. Its current scope is protected simulator software. Physical hardware integration is a further development step."}
        </p>
        <Link href={`/${locale}/products`}>
          {de
            ? "Produkte und Entwicklungsstand ansehen"
            : "Explore the products and their current scope"}{" "}
          →
        </Link>
      </section>
      <section className={styles.leadership}>
        <div>
          <p className="eyebrow">
            {de ? "LEITUNG & UNTERNEHMEN" : "LEADERSHIP & COMPANY"}
          </p>
          <h2>{company.managingDirector}</h2>
          <p>
            {de
              ? "Geschäftsführer · Onesa UG (haftungsbeschränkt)"
              : "Managing Director · Onesa UG (haftungsbeschränkt)"}
          </p>
        </div>
        <div>
          <h3>{de ? "Technischer Hintergrund" : "Engineering background"}</h3>
          <p>
            {de
              ? "Andrew Gotora verbindet Erfahrung in Full-Stack-Softwareentwicklung, IoT, DevOps und Elektronik. Er hat an Projekten in Bergbau, Landwirtschaft und Fertigung gearbeitet und nahm am AFRIKA KOMMT!-Programm 2021–2023 teil. Bei Onesa bringt er diesen Hintergrund in die Entwicklung der KI-Plattform, ihrer Anwendungen und der Robotik-Software ein."
              : "Andrew Gotora brings experience in full-stack software engineering, IoT, DevOps and electronics. His work spans projects in mining, agriculture and manufacturing, and he participated in the 2021–2023 AFRIKA KOMMT! programme. At Onesa, he applies this background to the development of the AI platform, its applications and robotics software."}
          </p>
          <p>
            <a
              href="https://www.linkedin.com/in/andrew-gotora-72966068"
              target="_blank"
              rel="noopener noreferrer"
            >
              {de ? "LinkedIn-Profil" : "LinkedIn profile"}
            </a>{" "}
            ·{" "}
            <a
              href="https://afrika-kommt.de/person/andrew-m-gotora/"
              target="_blank"
              rel="noopener noreferrer"
            >
              AFRIKA KOMMT!
            </a>
          </p>
          <p>
            {de
              ? `Onesa hat seinen Sitz in Heidelberg und ist beim ${company.registerCourt} unter ${company.registerNumber} eingetragen.`
              : `Onesa is based in Heidelberg and registered with ${company.registerCourt} under ${company.registerNumber}.`}
          </p>
          <Link href={`/${locale}/impressum`}>
            {de
              ? "Unternehmensangaben"
              : "Company particulars"}{" "}
            →
          </Link>
        </div>
      </section>
    </div>
  );
}

export function PlatformApproach({ locale }: { locale: Locale }) {
  const de = locale === "de";
  const steps = de
    ? [
        [
          "Eine Aufgabe",
          "Eine Frage, ausgewählte Dokumente oder ein Reiseplan geben den Kontext vor.",
        ],
        [
          "Berechtigtes Wissen",
          "Der Abruf bleibt an die Dokumente und Zugriffsrechte des angemeldeten Nutzers gebunden.",
        ],
        [
          "Modelle und Werkzeuge",
          "Konfigurierbare Modelle und registrierte, begrenzte Werkzeuge bearbeiten unterschiedliche Aufgaben.",
        ],
        [
          "Ein prüfbares Ergebnis",
          "Antworten, Quellenhinweise und Vorschläge unterstützen die nächste Entscheidung.",
        ],
      ]
    : [
        [
          "A task",
          "A question, selected documents or a travel plan establishes the context.",
        ],
        [
          "Permitted knowledge",
          "Retrieval stays bound to the signed-in user’s documents and access permissions.",
        ],
        [
          "Models and tools",
          "Configurable models and registered, bounded tools support different tasks.",
        ],
        [
          "A reviewable result",
          "Answers, source references and proposals support the next decision.",
        ],
      ];
  return (
    <section className={styles.approach} aria-labelledby="platform-approach">
      <p className="eyebrow">ONESA AI PLATFORM</p>
      <h2 id="platform-approach">
        {de
          ? "Vom Kontext zum nächsten Schritt"
          : "From context to the next step"}
      </h2>
      <p>
        {de
          ? "Die Plattform verbindet Modellinferenz mit Wissensabruf und konkreten Anwendungsabläufen. Chat, Knowledge, Agents und Travel nutzen dieselbe geschützte Grundlage und bieten jeweils einen passenden Arbeitsablauf."
          : "The platform connects model inference with knowledge retrieval and application workflows. Chat, Knowledge, Agents and Travel use the same protected foundation, with an interface suited to each task."}
      </p>
      <ol className={styles.flow}>
        {steps.map(([title, body]) => (
          <li key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </li>
        ))}
      </ol>
      <div className={styles.decisions}>
        <div>
          <h3>
            {de ? "Modulare Modellanbindung" : "Modular model integration"}
          </h3>
          <p>
            {de
              ? "Eine definierte Schnittstelle trennt Anwendungen von der konfigurierten Modellbereitstellung. Das ist keine Zusage, dass jedes Modell dieselbe Qualität oder dieselben Funktionen bietet."
              : "A defined interface separates applications from the configured model service. This does not imply that every model provides the same quality or capabilities."}
          </p>
        </div>
        <div>
          <h3>
            {de ? "Berechtigungen im Dienst" : "Authorization in the service"}
          </h3>
          <p>
            {de
              ? "Die Oberfläche organisiert die Arbeit; authentifizierte Dienste prüfen den Zugriff auf Gespräche, Dateien und Aufgaben. Öffentliche Produktseiten gewähren keinen Zugriff auf diese Daten."
              : "The interface organizes work; authenticated services check access to conversations, files and tasks. Public product pages grant no access to that data."}
          </p>
        </div>
        <div>
          <h3>{de ? "Begrenzte Abläufe" : "Bounded workflows"}</h3>
          <p>
            {de
              ? "Registrierte Werkzeuge arbeiten innerhalb ihrer erlaubten Aufgaben. Reisepläne sind editierbare Vorschläge, keine Buchungen. Robotik und physische KI benötigen eine separate Hardwareintegration und deren Validierung."
              : "Registered tools operate within their permitted tasks. Travel plans are editable suggestions, not bookings. Robotics and physical AI require separate hardware integration and validation."}
          </p>
        </div>
      </div>
      <Link href="https://docs.onesa.eu/docs/public/ai-platform">
        {de
          ? "Plattform und Schnittstellen verstehen"
          : "Understand the platform and its interfaces"}{" "}
        →
      </Link>
      <h2 className={styles.capabilitiesTitle}>
        {de
          ? "Die technischen Arbeitsbereiche"
          : "Our engineering capabilities"}
      </h2>
    </section>
  );
}
