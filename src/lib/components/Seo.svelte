<script lang="ts">
  import { page } from '$app/state';

  let { title, description }: {
    title: string;
    description: string;
  } = $props();

  const canonical = $derived(new URL('/', page.url.origin).href);
  const home = $derived(new URL('/', page.url.origin).href);
  const structuredData = $derived(JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        '@id': `${home}#app`,
        name: 'Core',
        url: home,
        description: 'Convert Khmer and English PDFs, documents, and images into editable Unicode text with browser-based OCR.',
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Web browser',
        featureList: ['Khmer and English OCR', 'PDF and image to text', 'Editable page previews', 'UTF-8 text export']
      },
      {
        '@type': 'WebPage',
        '@id': canonical,
        url: canonical,
        name: title,
        description,
        about: { '@id': `${home}#app` },
        inLanguage: 'en'
      }
    ]
  }).replace(/</g, '\\u003c'));
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={description} />
  <link rel="canonical" href={canonical} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Core" />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={description} />
  <meta property="og:url" content={canonical} />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content={title} />
  <meta name="twitter:description" content={description} />
  {@html `<script type="application/ld+json">${structuredData}</script>`}
</svelte:head>
