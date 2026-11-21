// ponytail: i18n shim — Director Studio runs English only today; translation
// keys pass through verbatim so their vendored components stay unmodified.
// This one module is aliased to BOTH `i18next` and `react-i18next` in the build.
// Upgrade path: drop the alias and install real i18next + react-i18next when other languages are requested.
const i18n = {
  language: 'en',
  resolvedLanguage: 'en',
  dir: 'ltr',
  exists: () => false,
  t: (k, opts) => (typeof k === 'string' ? k : String((k && k.key) || '')),
  changeLanguage: async () => {},
  use: () => i18n,
  init: () => i18n,
  addResourceBundle: () => {},
  on: () => {},
  off: () => {},
};
export default i18n;
export const initReactI18next = { type: '3rdParty', init: () => {} };
export function useTranslation() { return { t: i18n.t, i18n }; }
export function useI18n() { return i18n; }
export function Trans({ children, i18nKey }) { return children ?? i18nKey ?? null; }
