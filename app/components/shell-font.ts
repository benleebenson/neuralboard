import { Open_Sans } from "next/font/google";

// The browsing shell's typeface; the editor keeps its own fonts.
export const shellFont = Open_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-shell",
});
