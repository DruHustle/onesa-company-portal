export const tabRoles = {
  Dashboard: ["owner", "administrator", "editor", "business", "hr", "viewer"],
  "Governance & Compliance": ["owner", "administrator"],
  "Background Processing": ["owner", "administrator"],
  Content: ["owner", "administrator", "editor"],
  Enquiries: ["owner", "administrator", "business"],
  Applications: ["owner", "administrator", "hr"],
  Documents: ["owner", "administrator", "business", "hr"],
  Templates: ["owner", "administrator", "business"],
  Users: ["owner", "administrator"],
  Audit: ["owner", "administrator"],
  Facts: ["owner", "administrator"],
  Settings: ["owner", "administrator"],
  Security: ["owner", "administrator", "editor", "business", "hr", "viewer"],
} as const;
export type Tab = keyof typeof tabRoles;
export const taskGroups = [
  { label: "Overview", tabs: ["Dashboard"] },
  { label: "Website", tabs: ["Content"] },
  { label: "Business", tabs: ["Enquiries"] },
  { label: "Recruitment", tabs: ["Applications"] },
  { label: "Documents", tabs: ["Documents", "Templates"] },
  { label: "Governance", tabs: ["Governance & Compliance"] },
  {
    label: "Administration",
    tabs: [
      "Users",
      "Audit",
      "Background Processing",
      "Facts",
      "Settings",
      "Security",
    ],
  },
] satisfies { label: string; tabs: Tab[] }[];
export const tabLabel: Record<Tab, string> = {
  Dashboard: "Queues and exceptions",
  Content: "Content and publication",
  Enquiries: "Enquiries and follow-ups",
  Applications: "Applications and CVs",
  Documents: "Media and documents",
  Templates: "Templates",
  Users: "Staff and access",
  Audit: "Audit history",
  Facts: "Company particulars",
  Settings: "Advanced settings",
  Security: "My security",
  "Governance & Compliance": "Privacy governance",
  "Background Processing": "Operations",
};
export const applicationTransitions = {
  new: ["new", "review", "rejected"],
  review: ["review", "interview", "rejected"],
  interview: ["interview", "hired", "rejected"],
  rejected: ["rejected", "review"],
  hired: ["hired"],
} as const;
export const labels: Record<string, string> = {
  owner: "Owner",
  administrator: "Administrator",
  editor: "Editor",
  business: "Business staff",
  hr: "Recruitment staff",
  viewer: "Read-only staff",
  draft: "Draft",
  archived: "Archived",
  pending: "Awaiting approval",
  approved: "Approved",
  quarantine: "Awaiting security scan",
  clean: "Clean security scan",
  new: "New",
  active: "In progress",
  closed: "Closed",
  review: "In review",
  interview: "Interview",
  rejected: "Rejected",
  hired: "Hired",
  pending_review: "Awaiting review",
  needs_changes: "Changes requested",
  enquiries: "New enquiries",
  partnerships: "Open partnerships",
  applications: "New applications",
  documents: "Documents awaiting approval",
  drafts: "Working drafts",
  published: "Published editions",
  pendingJobs: "Pending background jobs",
  impressumApproved: "Company notice reviewed",
  privacyApproved: "Privacy notice reviewed",
  recruitmentApproved: "Recruitment processing reviewed",
  providersReviewed: "Service providers reviewed",
};
export type QueueState = {
  page: number;
  search: string;
  draftSearch: string;
  status?: string;
  category?: string;
};
export const emptyQueue = (): QueueState => ({
  page: 1,
  search: "",
  draftSearch: "",
});
export function sectionFromUrl(url: URL): Tab {
  const section = url.searchParams.get("section");
  return section && Object.hasOwn(tabRoles, section)
    ? (section as Tab)
    : url.hash.startsWith("#privacy")
      ? "Governance & Compliance"
      : "Dashboard";
}
