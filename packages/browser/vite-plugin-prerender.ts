import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';

interface PrerenderOptions {
  skinDir: string;
}

interface MetaConfig {
  title: string;
  description: string;
  canonicalUrl: string;
  og: {
    title: string;
    description: string;
    type: string;
    image: string;
    siteName: string;
  };
  twitter: {
    card: string;
    title: string;
    description: string;
    image: string;
  };
  jsonLd: {
    name: string;
    description: string;
    applicationCategory: string;
    operatingSystem: string;
  };
}

/**
 * Extract FAQ entries from HTML <details> elements for FAQPage JSON-LD.
 */
function extractFaqEntries(html: string): Array<{ question: string; answer: string }> {
  const entries: Array<{ question: string; answer: string }> = [];
  const detailsRegex = /<details[^>]*class="faq__item"[^>]*>\s*<summary>(.*?)<\/summary>\s*<p>(.*?)<\/p>\s*<\/details>/gs;
  let match;
  while ((match = detailsRegex.exec(html)) !== null) {
    entries.push({
      question: match[1].trim(),
      answer: match[2].trim(),
    });
  }
  return entries;
}

/**
 * Generate meta tags HTML string from meta config.
 */
function generateMetaTags(meta: MetaConfig): string {
  const tags: string[] = [];

  tags.push(`<title>${meta.title}</title>`);
  tags.push(`<meta name="description" content="${meta.description}">`);
  tags.push(`<link rel="canonical" href="${meta.canonicalUrl}">`);

  // Open Graph
  tags.push(`<meta property="og:title" content="${meta.og.title}">`);
  tags.push(`<meta property="og:description" content="${meta.og.description}">`);
  tags.push(`<meta property="og:type" content="${meta.og.type}">`);
  tags.push(`<meta property="og:url" content="${meta.canonicalUrl}">`);
  tags.push(`<meta property="og:image" content="${meta.og.image}">`);
  tags.push(`<meta property="og:site_name" content="${meta.og.siteName}">`);

  // Twitter Card
  tags.push(`<meta name="twitter:card" content="${meta.twitter.card}">`);
  tags.push(`<meta name="twitter:title" content="${meta.twitter.title}">`);
  tags.push(`<meta name="twitter:description" content="${meta.twitter.description}">`);
  tags.push(`<meta name="twitter:image" content="${meta.twitter.image}">`);

  return tags.join('\n    ');
}

/**
 * Generate JSON-LD structured data.
 */
function generateJsonLd(meta: MetaConfig, faqEntries: Array<{ question: string; answer: string }>): string {
  const scripts: string[] = [];

  // SoftwareApplication
  const appLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: meta.jsonLd.name,
    description: meta.jsonLd.description,
    url: meta.canonicalUrl,
    applicationCategory: meta.jsonLd.applicationCategory,
    operatingSystem: meta.jsonLd.operatingSystem,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    author: {
      '@type': 'Organization',
      name: meta.jsonLd.name,
      url: meta.canonicalUrl,
    },
  };
  scripts.push(`<script type="application/ld+json">${JSON.stringify(appLd)}</script>`);

  // FAQPage (if FAQ entries found)
  if (faqEntries.length > 0) {
    const faqLd = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqEntries.map(e => ({
        '@type': 'Question',
        name: e.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: e.answer,
        },
      })),
    };
    scripts.push(`<script type="application/ld+json">${JSON.stringify(faqLd)}</script>`);
  }

  return scripts.join('\n    ');
}

/**
 * Extract critical CSS for above-fold content (hero section + basic layout).
 */
function extractCriticalCss(fullCss: string): string {
  // Include key sections: :host, .homepage, .section, .section--hero, .hero__*, .btn--cta, headings, responsive
  const criticalSelectors = [
    // :host is shadow DOM only — not relevant for prerendered content
    '.homepage',
    '.section ',  // note trailing space to avoid .section--hero match issues
    '.section--hero',
    '.section--cta',
    '.section__inner',
    '.hero__title',
    '.hero__tagline',
    '.hero__pitch',
    '.hero__legacy',
    '.btn',
    '.btn--cta',
    '.btn--large',
    '.btn--secondary',
    'h2',
    'h3',
  ];

  // Simple approach: include all rules that match critical selectors
  // This is good enough for build-time — not a runtime concern
  const lines = fullCss.split('\n');
  const criticalLines: string[] = [];
  let inBlock = false;
  let braceDepth = 0;
  let currentBlock = '';

  for (const line of lines) {
    if (!inBlock) {
      // Check if this line starts a rule block we want
      const isCritical = criticalSelectors.some(sel => line.trimStart().startsWith(sel)) ||
        line.trimStart().startsWith('@media');
      if (line.includes('{')) {
        if (isCritical) {
          inBlock = true;
          braceDepth = 0;
          currentBlock = '';
        }
      }
    }

    if (inBlock) {
      currentBlock += line + '\n';
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      if (braceDepth <= 0) {
        criticalLines.push(currentBlock);
        inBlock = false;
        currentBlock = '';
      }
    }
  }

  return criticalLines.join('\n');
}

/**
 * Rewrite relative asset URLs to absolute URLs based on skin base URL.
 * Mirrors OuterSkinContainer.rewriteAssetUrls() so prerendered content
 * references the correct /skins/{skinId}/assets/ paths.
 */
function rewriteAssetUrls(content: string, skinBaseUrl: string): string {
  // Rewrite url() in CSS
  content = content.replace(
    /url\(['"]?(?!data:|https?:|\/\/)(\.?\/?assets\/[^'")\s]+)['"]?\)/gi,
    (_match, assetPath: string) => {
      const cleanPath = assetPath.replace(/^\.?\//, '');
      return `url('${skinBaseUrl}/${cleanPath}')`;
    }
  );

  // Rewrite src=, href=, poster= in HTML for assets
  content = content.replace(
    /(src|href|poster)=["'](?!data:|https?:|\/\/|#)(\.?\/?assets\/[^"']+)["']/gi,
    (_match, attr: string, assetPath: string) => {
      const cleanPath = assetPath.replace(/^\.?\//, '');
      return `${attr}="${skinBaseUrl}/${cleanPath}"`;
    }
  );

  return content;
}

/**
 * Wrap skin content in semantic prerendered container.
 * Converts the skin's .homepage div structure to use semantic HTML tags.
 */
function wrapInSemanticHtml(content: string): string {
  // The content is already well-structured with sections.
  // Wrap it in a main tag for semantic meaning.
  // Replace the outer .homepage div with semantic <main>
  let semantic = content
    .replace('<div class="homepage">', '<main class="homepage" role="main">')
    .replace(/<\/div>\s*$/, '</main>');

  return `<div id="prerendered-homepage">\n${semantic}\n</div>`;
}

/**
 * Scope CSS rules to #prerendered-homepage so they don't leak into the app.
 * Prefixes each selector with #prerendered-homepage, handling @media blocks.
 */
function scopeCssToPrerendered(css: string): string {
  const SCOPE = '#prerendered-homepage';
  const lines = css.split('\n');
  const result: string[] = [];
  let inMedia = false;

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (trimmed.startsWith('@media')) {
      inMedia = true;
      result.push(line);
      continue;
    }

    // Closing brace for @media
    if (inMedia && trimmed === '}' && !line.startsWith('  ')) {
      inMedia = false;
      result.push(line);
      continue;
    }

    // Rule selector line (contains { but isn't just a closing brace)
    if (trimmed.includes('{') && !trimmed.startsWith('}') && !trimmed.startsWith('/*')) {
      // Prefix selector with scope
      const indent = line.match(/^(\s*)/)?.[1] || '';
      const selector = trimmed.replace(/\s*\{/, '').trim();
      result.push(`${indent}${SCOPE} ${selector} {`);
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

export function prerenderPlugin(options: PrerenderOptions): Plugin {
  return {
    name: 'flo-prerender',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const { skinDir } = options;

        // Read skin source files
        let content: string;
        let styles: string;
        let meta: MetaConfig;

        try {
          content = fs.readFileSync(path.resolve(skinDir, 'content.html'), 'utf-8');
        } catch {
          console.warn('[flo-prerender] No content.html found in skin dir, skipping prerender');
          return html;
        }

        try {
          styles = fs.readFileSync(path.resolve(skinDir, 'styles.css'), 'utf-8');
        } catch {
          styles = '';
        }

        try {
          meta = JSON.parse(fs.readFileSync(path.resolve(skinDir, 'meta.json'), 'utf-8'));
        } catch {
          console.warn('[flo-prerender] No meta.json found in skin dir, skipping meta injection');
          return html;
        }

        // Derive skin base URL from skinDir (e.g. .../public/skins/flo-monster → /skins/flo-monster)
        const skinId = path.basename(skinDir);
        const skinBaseUrl = `/skins/${skinId}`;

        // Rewrite relative asset paths to absolute skin paths
        content = rewriteAssetUrls(content, skinBaseUrl);
        styles = rewriteAssetUrls(styles, skinBaseUrl);

        // Generate components
        const metaTags = generateMetaTags(meta);
        const faqEntries = extractFaqEntries(content);
        const jsonLd = generateJsonLd(meta, faqEntries);
        const criticalCss = extractCriticalCss(styles);
        const prerenderedContent = wrapInSemanticHtml(content);

        // Inject meta tags — replace the existing <title>flo.monster</title> line
        html = html.replace(
          '<title>flo.monster</title>',
          `${metaTags}\n    ${jsonLd}`
        );

        // Inject critical CSS before the stylesheet link, scoped to #prerendered-homepage
        // to prevent skin styles (h2, h3, .btn) from leaking into the app dashboard
        const scopedCss = scopeCssToPrerendered(criticalCss);
        html = html.replace(
          '<link rel="stylesheet" href="/src/ui/styles.css" />',
          `<style id="critical-css">\n${scopedCss}\n    </style>\n  <link rel="stylesheet" href="/src/ui/styles.css" />`
        );

        // Inject prerendered content before outer-skin-root
        html = html.replace(
          '<div id="outer-skin-root"></div>',
          `${prerenderedContent}\n    <div id="outer-skin-root"></div>`
        );

        return html;
      },
    },
  };
}
