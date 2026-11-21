// ponytail: i18n shim — Director Studio runs English only today. It stores the
// app's real en-US resource tree (fed at mount via addResourceBundle) and
// resolves t() through it with defaultValue + {{interp}} fallbacks, so the
// vendored components stay unmodified.
// This one module is aliased to BOTH `i18next` and `react-i18next` in the build.
// Upgrade path: drop the alias and install real i18next + react-i18next when other languages are requested.
const resources = {};

function lookup(tree, key) {
  let node = tree;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(text, opts) {
  if (!opts) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (m, name) => (opts[name] !== undefined ? String(opts[name]) : m));
}

const i18n = {
  language: 'en',
  resolvedLanguage: 'en',
  dir: 'ltr',
  exists: (k) => lookup((resources[i18n.language] || {}).translation, k) !== undefined,
  t: (k, opts) => {
    const key = typeof k === 'string' ? k : String((k && k.key) || '');
    const found = lookup((resources[i18n.language] || {}).translation, key);
    if (found !== undefined) return interpolate(found, opts);
    if (opts && typeof opts.defaultValue === 'string') return interpolate(opts.defaultValue, opts);
    return key;
  },
  changeLanguage: async (lng) => { i18n.language = lng; i18n.resolvedLanguage = lng; },
  use: () => i18n,
  init: (opts) => {
    for (const [lng, byNs] of Object.entries((opts && opts.resources) || {}))
      for (const [ns, data] of Object.entries(byNs)) i18n.addResourceBundle(lng, ns, data);
    return i18n;
  },
  addResourceBundle: (lng, ns, data) => {
    const bag = (resources[lng] = resources[lng] || {});
    bag[ns] = Object.assign({}, bag[ns], data);
  },
  on: () => {},
  off: () => {},
};
export default i18n;
export const initReactI18next = { type: '3rdParty', init: () => {} };
export function useTranslation() { return { t: i18n.t, i18n }; }
export function useI18n() { return i18n; }
export function Trans({ children, i18nKey }) { return children ?? i18n.t(i18nKey) ?? null; }
