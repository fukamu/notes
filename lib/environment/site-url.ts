const DEFAULT_SITE_URL = 'https://fukamu-notes-cards.matoruru.chatgpt.site';

export class SiteUrlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteUrlConfigurationError';
  }
}

export function resolveSiteUrl(value: unknown): URL {
  if (value === undefined || value === '') return new URL(DEFAULT_SITE_URL);
  if (typeof value !== 'string') {
    throw new SiteUrlConfigurationError(
      'NEXT_PUBLIC_SITE_URL must be an absolute HTTP(S) URL',
    );
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SiteUrlConfigurationError(
        'NEXT_PUBLIC_SITE_URL must use HTTP or HTTPS',
      );
    }
    return url;
  } catch (error) {
    if (error instanceof SiteUrlConfigurationError) throw error;
    throw new SiteUrlConfigurationError(
      'NEXT_PUBLIC_SITE_URL must be an absolute HTTP(S) URL',
    );
  }
}
