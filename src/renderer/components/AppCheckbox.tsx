import { Checkbox } from "@base-ui/react/checkbox";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { blurAfterMouseActivation } from "./blurAfterMouseActivation";
import { AppIcon } from "@/components/AppIcon";

interface AppCheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

/// A square form checkbox (Base UI Checkbox). Use for non-exclusive
/// selections like "include video / include audio" in the export dialog,
/// where two boxes read more naturally as a picklist than two switches. For
/// an immediate on/off state, prefer AppSwitch instead.
export function AppCheckbox({
  checked,
  onCheckedChange,
  disabled,
  ariaLabel,
  className,
}: AppCheckboxProps) {
  return (
    <Checkbox.Root
      className={cn("app-checkbox", className)}
      checked={checked}
      disabled={disabled ?? false}
      aria-label={ariaLabel}
      onCheckedChange={(next) => onCheckedChange(next)}
      onClick={blurAfterMouseActivation}
    >
      <Checkbox.Indicator className="app-checkbox-indicator">
        <AppIcon icon={CheckIcon} size="body" aria-hidden />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}
