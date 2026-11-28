type IconName = "conversations" | "workspace" | "providers" | "diagnostics" | "send" | "sun" | "moon" | "appearance" | "chevron" | "outline" | "edit" | "search";

const paths: Record<IconName, string> = {
  conversations: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z M7 9h10 M7 13h6",
  workspace: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z M3 9h18",
  providers: "M8 3v4 M16 3v4 M5 7h14v3a7 7 0 0 1-14 0V7Z M12 17v4",
  diagnostics: "M3 12h4l3-7 4 14 3-7h4",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5",
  moon: "M20.5 13.5A8.7 8.7 0 0 1 10.5 3.5a8.8 8.8 0 1 0 10 10Z",
  appearance: "M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.2-2.5H18a3 3 0 0 0 3-3.2A9 9 0 0 0 12 3Z M7 10h.01 M10 6.5h.01 M15 7h.01 M17.5 11h.01",
  chevron: "m8 10 4 4 4-4",
  outline: "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01",
  edit: "m15 4 5 5 M4 20l5-1 11-11a2 2 0 0 0-5-4L4 15v5Z",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6",
  send: "M12 19V5 M6 11l6-6 6 6",
};

export default function StudioIcon({ name }: { name: IconName }) {
  return <svg className="studio-icon" viewBox="0 0 24 24" fill="none" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={paths[name]} />
  </svg>;
}
