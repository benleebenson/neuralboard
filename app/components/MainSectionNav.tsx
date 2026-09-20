"use client";

import Link from "next/link";
import { useState } from "react";
import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { ADMIN_EMAIL } from "@/lib/admin";
import styles from "./MainSectionNav.module.css";

export type MainSection = "world" | "board" | "clips" | "projects" | "library" | "public";

const sections: Array<{ id: MainSection; href: string; label: string; icon: string }> = [
  { id: "public", href: "/public", label: "Join Board", icon: "◎" },
  { id: "world", href: "/board2?world=1", label: "World", icon: "∞" },
  { id: "board", href: "/board2?mobileEditor=1", label: "Board", icon: "✎" },
  { id: "clips", href: "/clips", label: "Clips", icon: "✂" },
  { id: "projects", href: "/projects", label: "Projects", icon: "☁" },
  { id: "library", href: "/board2/library?tab=assets&curate=1", label: "Library", icon: "▦" },
];

export function MainSectionNav({ active, desktopOnly = false, onOpenWorld }: { active: MainSection; desktopOnly?: boolean; onOpenWorld?: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: session } = useSession(); const owner = session?.user?.email === ADMIN_EMAIL; const [pending,setPending]=useState(0);
  useEffect(()=>{if(!owner)return;void fetch("/api/public-board/moderation?count=1").then(response=>response.ok?response.json():null).then(data=>setPending(data?.count??0)).catch(()=>{})},[owner]);
  const visibleSections = owner ? sections : sections.filter((section) => section.id === "public");
  const links = visibleSections.map((section) => section.id === "world" && onOpenWorld ? (
    <button key={section.id} type="button" aria-current={section.id === active ? "page" : undefined} className={styles.link} onClick={() => { setOpen(false); onOpenWorld(); }}>
      <span aria-hidden="true">{section.icon}</span> {section.label}
    </button>
  ) : (
    <Link key={section.id} href={section.href} aria-current={section.id === active ? "page" : undefined} className={styles.link} onClick={() => setOpen(false)}>
      <span aria-hidden="true">{section.icon}</span> {section.label}{section.id==="public"&&pending>0?<span className={styles.badge}>{pending}</span>:null}
    </Link>
  ));

  return (
    <div className={`${styles.root} ${desktopOnly ? styles.desktopOnly : ""}`}>
      <nav className={styles.desktop} aria-label="Main sections">{links}</nav>
      {!desktopOnly && <div className={styles.mobile}>
        <button type="button" className={styles.trigger} aria-label="Open main menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>☰</button>
        {open && <nav className={styles.menu} aria-label="Main sections">{links}</nav>}
      </div>}
      {owner&&pending>0?<Link className={styles.moderate} href="/public/moderate">Review {pending}</Link>:null}
    </div>
  );
}
