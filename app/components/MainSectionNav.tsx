"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "./MainSectionNav.module.css";

export type MainSection = "board" | "clips" | "library";

const sections: Array<{ id: MainSection; href: string; label: string; icon: string }> = [
  { id: "board", href: "/board2", label: "Board", icon: "✎" },
  { id: "clips", href: "/clips", label: "Clips", icon: "✂" },
  { id: "library", href: "/board2/library", label: "Library", icon: "▦" },
];

export function MainSectionNav({ active, desktopOnly = false }: { active: MainSection; desktopOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const links = sections.map((section) => (
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
