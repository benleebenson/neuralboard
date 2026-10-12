"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "next-auth/react";
import { ADMIN_EMAIL } from "@/lib/admin";
import styles from "./MainSectionNav.module.css";

export type MainSection = "board" | "clips" | "projects" | "library" | "public";

const sections: Array<{ id: MainSection; href: string; label: string; icon: string }> = [
  { id: "public", href: "/public", label: "Join Board", icon: "◎" },
  { id: "board", href: "/board2?mobileEditor=1", label: "Board", icon: "✎" },
  { id: "clips", href: "/clips", label: "Clips", icon: "✂" },
  { id: "projects", href: "/projects", label: "Projects", icon: "☁" },
  { id: "library", href: "/board2/library", label: "Library", icon: "▦" },
];

export function MainSectionNav({ active, desktopOnly = false }: { active: MainSection; desktopOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const { data: session } = useSession(); const owner = session?.user?.email === ADMIN_EMAIL;
  const visibleSections = owner ? sections : sections.filter((section) => section.id === "public");
  const links = visibleSections.map((section) => (
    <Link key={section.id} href={section.href} aria-current={section.id === active ? "page" : undefined} className={styles.link} onClick={() => setOpen(false)}>
      <span aria-hidden="true">{section.icon}</span> {section.label}
    </Link>
  ));

  return (
    <div className={`${styles.root} ${desktopOnly ? styles.desktopOnly : ""}`}>
      <nav className={styles.desktop} aria-label="Main sections">{links}</nav>
      {!desktopOnly && <div className={styles.mobile}>
        <button type="button" className={styles.trigger} aria-label="Open main menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>☰</button>
        {open && <nav className={styles.menu} aria-label="Main sections">{links}</nav>}
      </div>}
    </div>
  );
}
