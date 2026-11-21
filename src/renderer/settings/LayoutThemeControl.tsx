import { useTranslation } from "react-i18next";
import { AppSelect } from "../components/AppSelect";
import { LAYOUT_THEME_IDS, isLayoutTheme, recommendLayoutTheme } from "../../shared/layout-theme";
import { setAppSettings, useLayoutTheme } from "./appSettingsStore";
import { useDisplayMetrics } from "./layoutTheme";

/** Layout theme selector. The preset matching the current display carries a
 * "Recommended" tag inside the open list only, where the choice is made; a
 * deliberate different choice leaves no persistent notice behind. */
export function LayoutThemeControl({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation();
  const layoutTheme = useLayoutTheme();
  const display = useDisplayMetrics();
  const recommended = display
    ? recommendLayoutTheme(display, { width: display.availWidth, height: display.availHeight })
    : null;
  return (
    <>
      <div className="settings-control-row">
        <span className="settings-toggle-label">{t("settings.layout_theme")}</span>
        <AppSelect
          className="settings-select"
          ariaLabel={t("settings.layout_theme")}
          value={layoutTheme}
          options={LAYOUT_THEME_IDS.map(value => ({
            value,
            label: t(`settings.layout_themes.${value}`),
            detail: display && value === recommended && (
              <span
                className="layout-theme-recommended"
                title={t("settings.layout_theme_recommended_detail", {
                  width: display.width,
                  height: display.height,
                  scale: display.scalePercent,
                })}
              >
                {t("settings.layout_theme_recommended")}
              </span>
            ),
          }))}
          onValueChange={value => {
            if (isLayoutTheme(value)) void setAppSettings({ layout_theme: value }).catch(err => onError(String(err)));
          }}
        />
      </div>
      <p className="settings-toggle-hint">{t("settings.layout_theme_hint")}</p>
    </>
  );
}
