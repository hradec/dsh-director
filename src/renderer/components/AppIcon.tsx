import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";

/// Icon sizes are named after the text role an icon sits beside, so a glyph and
/// its label scale together with the layout theme. Baselines and tokens live in
/// `styles/layout-theme.css` (`--icon-size-*`); never pass a pixel size.
export type IconSize =
  | "fine"
  | "micro"
  | "caption"
  | "body"
  | "label"
  | "title"
  | "heading"
  | "display";

type AppIconProps = Omit<LucideProps, "size" | "ref"> & {
  /// A lucide glyph, or a hand-drawn one shaped like it.
  icon: ComponentType<LucideProps>;
  size?: IconSize;
};

/// The one way application chrome draws an icon. CSS sizes the glyph from the
/// role token, overriding lucide's intrinsic 24px attributes.
export function AppIcon({ icon: Icon, size = "body", className, ...props }: AppIconProps) {
  return <Icon className={cn("app-icon", `app-icon-${size}`, className)} {...props} />;
}
