'use client';

import type { ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components';
import type { Lang } from '@/lib/lang';
import { LazyToaster } from './lazy';

/** The locale the kit formats dates in: Thai shows Buddhist-era years, English a 24h clock. */
export const KIT_LOCALE: Record<Lang, string> = { en: 'en-GB', th: 'th-TH' };

/** Once, in the root layout: the kit's locale and the toast region. */
export function UiProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return (
    <I18nProvider locale={KIT_LOCALE[lang]}>
      {children}
      <LazyToaster />
    </I18nProvider>
  );
}
